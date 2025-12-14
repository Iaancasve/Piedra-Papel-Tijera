const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

const sequelize = require('./config/db');
const User = require('./models/User');
const Game = require('./models/Game');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static('public'));
app.use('/api/auth', require('./routes/authRoutes'));

/* Middleware de autenticación WebSocket */
io.use((socket, next) => {
    try {
        socket.user = jwt.verify(
            socket.handshake.auth.token,
            'mi_secreto_super_seguro'
        );
        next();
    } catch {
        next(new Error('Token inválido'));
    }
});

const movimientos = {}; // Jugadas temporales por partida

io.on('connection', (socket) => {
    const userId = socket.user.id;

    enviarRanking(io);

    /* Recuperar partida activa si existe */
    (async () => {
        const partida = await Game.findOne({
            where: {
                [Op.or]: [
                    { jugador1Id: userId },
                    { jugador2Id: userId }
                ],
                estado: ['esperando', 'jugando']
            }
        });

        if (partida) {
            socket.join(`partida_${partida.id}`);
            socket.emit('partida_en_curso', {
                gameId: partida.id,
                tipo: partida.tipo,
                estado: partida.estado,
                jugador1Id: partida.jugador1Id
            });
        }
    })();

    socket.on('obtener_partidas', async () => {
        const partidas = await Game.findAll({
            where: { estado: 'esperando', tipo: 'humano' },
            include: [{ model: User, as: 'Jugador1', attributes: ['username'] }]
        });
        socket.emit('lista_partidas', partidas);
    });

    socket.on('crear_partida', async (tipo) => {
        const existe = await Game.findOne({
            where: {
                [Op.or]: [
                    { jugador1Id: userId },
                    { jugador2Id: userId }
                ],
                estado: ['esperando', 'jugando']
            }
        });

        if (existe) return socket.emit('error', 'Ya tienes partida.');

        const game = await Game.create({
            tipo,
            estado: tipo === 'cpu' ? 'jugando' : 'esperando',
            jugador1Id: userId
        });

        socket.join(`partida_${game.id}`);

        if (tipo === 'humano') {
            io.emit('lista_partidas', await Game.findAll({
                where: { estado: 'esperando', tipo: 'humano' },
                include: [{ model: User, as: 'Jugador1' }]
            }));
            socket.emit('partida_creada', {
                mensaje: 'Esperando...',
                gameId: game.id
            });
        } else {
            socket.emit('partida_empezada', {
                gameId: game.id,
                oponente: 'CPU',
                jugador1Id: userId
            });
        }
    });

    socket.on('unirse_partida', async (gameId) => {
        const game = await Game.findByPk(gameId);
        if (!game || game.estado !== 'esperando') {
            return socket.emit('error', 'No disponible.');
        }

        game.jugador2Id = userId;
        game.estado = 'jugando';
        await game.save();

        socket.join(`partida_${gameId}`);

        io.to(`partida_${gameId}`).emit('partida_empezada', {
            gameId,
            oponente: 'Humano',
            jugador1Id: game.jugador1Id
        });

        io.emit('lista_partidas', await Game.findAll({
            where: { estado: 'esperando', tipo: 'humano' },
            include: [{ model: User, as: 'Jugador1' }]
        }));
    });

    socket.on('jugada', async (op) => {
        const game = await Game.findOne({
            where: {
                [Op.or]: [
                    { jugador1Id: userId },
                    { jugador2Id: userId }
                ],
                estado: 'jugando'
            }
        });

        if (!game) return;

        movimientos[game.id] ||= {};
        const esP1 = game.jugador1Id === userId;
        movimientos[game.id][esP1 ? 'p1' : 'p2'] = op;

        if (game.tipo === 'cpu') {
            const cpuOp = ['piedra', 'papel', 'tijera']
                [Math.floor(Math.random() * 3)];
            await resolverRonda(game, movimientos[game.id].p1, cpuOp, io);
        } else if (movimientos[game.id].p1 && movimientos[game.id].p2) {
            await resolverRonda(
                game,
                movimientos[game.id].p1,
                movimientos[game.id].p2,
                io
            );
        } else {
            socket.emit('esperando_rival', `Elegiste ${op}.`);
            socket.to(`partida_${game.id}`)
                  .emit('oponente_listo', 'Rival listo');
        }
    });

    socket.on('abandonar_partida', async () => {
        const game = await Game.findOne({
            where: {
                [Op.or]: [
                    { jugador1Id: userId },
                    { jugador2Id: userId }
                ],
                estado: ['esperando', 'jugando']
            }
        });

        if (!game) return;

        game.estado = 'finalizada';
        game.ganadorId =
            game.jugador1Id === userId
                ? game.jugador2Id
                : game.jugador1Id;

        await game.save();

        io.to(`partida_${game.id}`)
          .emit('partida_terminada', { mensaje: 'Rival abandonó.' });

        socket.leave(`partida_${game.id}`);
        socket.emit('abandono_exitoso');
        enviarRanking(io);
    });
});

/* Resolver ronda y fin de partida */
async function resolverRonda(game, t1, t2, io) {
    let win = null;

    if (t1 !== t2) {
        win =
            (t1 === 'piedra' && t2 === 'tijera') ||
            (t1 === 'papel' && t2 === 'piedra') ||
            (t1 === 'tijera' && t2 === 'papel')
                ? 1
                : 2;
    }

    if (win === 1) game.puntosJugador1++;
    if (win === 2) game.puntosJugador2++;

    await game.save();

    io.to(`partida_${game.id}`).emit('resultado_ronda', {
        tiro1: t1,
        tiro2: t2,
        ganadorRonda: win || 'empate',
        marcador: {
            p1: game.puntosJugador1,
            p2: game.puntosJugador2
        }
    });

    delete movimientos[game.id];

    if (game.puntosJugador1 >= 3 || game.puntosJugador2 >= 3) {
        game.estado = 'finalizada';
        game.ganadorId =
            game.puntosJugador1 >= 3
                ? game.jugador1Id
                : game.jugador2Id;

        await game.save();

        const j1 = await User.findByPk(game.jugador1Id);
        j1.partidasJugadas++;
        if (game.puntosJugador1 >= 3) j1.partidasGanadas++;
        await j1.save();

        if (game.tipo === 'humano') {
            const j2 = await User.findByPk(game.jugador2Id);
            j2.partidasJugadas++;
            if (game.puntosJugador2 >= 3) j2.partidasGanadas++;
            await j2.save();
        }

        io.to(`partida_${game.id}`).emit('fin_partida', {
            ganador:
                game.puntosJugador1 >= 3
                    ? 'Jugador 1'
                    : 'Jugador 2/CPU'
        });

        enviarRanking(io);
    }
}

/* Calcular y emitir ranking */
async function enviarRanking(io) {
    const users = await User.findAll();

    const ranking = users
        .map(u => ({
            user: u.username,
            wins: u.partidasGanadas,
            total: u.partidasJugadas,
            pct: u.partidasJugadas
                ? ((u.partidasGanadas / u.partidasJugadas) * 100).toFixed(1)
                : 0
        }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 10);

    io.emit('ranking_actualizado', ranking);
}

sequelize.sync({ force: false }).then(() => {
    server.listen(3000, () =>
        console.log('Servidor en puerto 3000')
    );
});