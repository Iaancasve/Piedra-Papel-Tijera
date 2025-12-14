const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const sequelize = require('./config/db');
const User = require('./models/User');
const Game = require('./models/Game');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const movimientos = {};

app.use(express.json());
app.use(express.static('public'));

app.use('/api/auth', require('./routes/authRoutes'));

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Acceso denegado: Falta token"));
    }

    try {
        const decoded = jwt.verify(token, 'mi_secreto_super_seguro');
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error("Token inválido"));
    }
});

io.on('connection', (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;
    console.log(`Usuario conectado: ${username}`);

    // 1. ENVIAR RANKING AL CONECTAR
    enviarRanking(io);

    (async () => {
        const partidaPendiente = await Game.findOne({
            where: {
                [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                estado: ['esperando', 'jugando']
            }
        });

        if (partidaPendiente) {
            socket.join(`partida_${partidaPendiente.id}`);
            socket.emit('partida_en_curso', {
                gameId: partidaPendiente.id,
                tipo: partidaPendiente.tipo,
                estado: partidaPendiente.estado,
                jugador1Id: partidaPendiente.jugador1Id
            });
        }
    })();

    socket.on('obtener_partidas', async () => {
        try {
            const partidas = await Game.findAll({
                where: { estado: 'esperando', tipo: 'humano' },
                include: [{ model: User, as: 'Jugador1', attributes: ['username'] }]
            });
            socket.emit('lista_partidas', partidas);
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('crear_partida', async (tipo) => {
        try {
            const partidaAbierta = await Game.findOne({
                where: {
                    [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                    estado: ['esperando', 'jugando']
                }
            });

            if (partidaAbierta) {
                return socket.emit('error', 'Ya tienes una partida en curso.');
            }

            const estadoInicial = (tipo === 'cpu') ? 'jugando' : 'esperando';

            const nuevaPartida = await Game.create({
                tipo: tipo,
                estado: estadoInicial,
                jugador1Id: userId
            });

            socket.join(`partida_${nuevaPartida.id}`);

            if (tipo === 'humano') {
                const partidasDisponibles = await Game.findAll({
                    where: { estado: 'esperando', tipo: 'humano' },
                    include: [{ model: User, as: 'Jugador1', attributes: ['username'] }]
                });
                io.emit('lista_partidas', partidasDisponibles);
                socket.emit('partida_creada', { mensaje: 'Esperando oponente...', gameId: nuevaPartida.id });
            } else {
                socket.emit('partida_empezada', {
                    gameId: nuevaPartida.id,
                    oponente: 'CPU',
                    jugador1Id: userId
                });
            }
        } catch (error) {
            console.error(error);
            socket.emit('error', 'Error al crear partida');
        }
    });

    socket.on('unirse_partida', async (gameId) => {
        try {
            const partidaAbierta = await Game.findOne({
                where: {
                    [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                    estado: ['esperando', 'jugando']
                }
            });

            if (partidaAbierta) return socket.emit('error', 'Ya tienes una partida en curso.');

            const partida = await Game.findByPk(gameId);
            if (!partida || partida.estado !== 'esperando') {
                return socket.emit('error', 'Esa partida ya no está disponible');
            }

            partida.jugador2Id = userId;
            partida.estado = 'jugando';
            await partida.save();

            socket.join(`partida_${gameId}`);

            io.to(`partida_${gameId}`).emit('partida_empezada', {
                gameId: gameId,
                oponente: 'Humano',
                jugador1Id: partida.jugador1Id
            });

            const partidasDisponibles = await Game.findAll({
                where: { estado: 'esperando', tipo: 'humano' },
                include: [{ model: User, as: 'Jugador1', attributes: ['username'] }]
            });
            io.emit('lista_partidas', partidasDisponibles);
        } catch (error) {
            console.error(error);
            socket.emit('error', 'Error al unirse');
        }
    });

    socket.on('abandonar_partida', async () => {
        try {
            const partida = await Game.findOne({
                where: {
                    [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                    estado: ['esperando', 'jugando']
                }
            });

            if (partida) {
                partida.estado = 'finalizada';
                partida.ganadorId = (partida.jugador1Id === userId) ? partida.jugador2Id : partida.jugador1Id;
                await partida.save();

                io.to(`partida_${partida.id}`).emit('partida_terminada', {
                    mensaje: 'El oponente ha abandonado la partida. ¡Ganaste!'
                });

                socket.leave(`partida_${partida.id}`);
                socket.emit('abandono_exitoso');
                
                // 2. ACTUALIZAR RANKING AL ABANDONAR
                enviarRanking(io);
            }
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('jugada', async (opcion) => {
        try {
            const partida = await Game.findOne({
                where: {
                    [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                    estado: 'jugando'
                }
            });

            if (!partida) return;

            const gameId = partida.id;

            if (!movimientos[gameId]) {
                movimientos[gameId] = { jugada1: null, jugada2: null };
            }

            let soyJugador1 = (partida.jugador1Id === userId);

            if (soyJugador1) {
                movimientos[gameId].jugada1 = opcion;
            } else {
                movimientos[gameId].jugada2 = opcion;
            }

            if (partida.tipo === 'cpu') {
                const opcionesCPU = ['piedra', 'papel', 'tijera'];
                const jugadaCPU = opcionesCPU[Math.floor(Math.random() * 3)];
                movimientos[gameId].jugada2 = jugadaCPU;
                await resolverRonda(partida, movimientos[gameId].jugada1, jugadaCPU);
            } else {
                if (movimientos[gameId].jugada1 && movimientos[gameId].jugada2) {
                    await resolverRonda(partida, movimientos[gameId].jugada1, movimientos[gameId].jugada2);
                } else {
                    socket.emit('esperando_rival', 'Has elegido ' + opcion + '. Esperando al oponente...');
                    socket.to(`partida_${gameId}`).emit('oponente_listo', '¡El oponente ya ha elegido!');
                }
            }
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${username}`);
    });
});

async function resolverRonda(partida, tiro1, tiro2) {
    let ganadorRonda = null;

    if (tiro1 === tiro2) {
        ganadorRonda = 'empate';
    } else if (
        (tiro1 === 'piedra' && tiro2 === 'tijera') ||
        (tiro1 === 'papel' && tiro2 === 'piedra') ||
        (tiro1 === 'tijera' && tiro2 === 'papel')
    ) {
        ganadorRonda = 1;
        partida.puntosJugador1 += 1;
    } else {
        ganadorRonda = 2;
        partida.puntosJugador2 += 1;
    }

    await partida.save();

    io.to(`partida_${partida.id}`).emit('resultado_ronda', {
        tiro1,
        tiro2,
        ganadorRonda,
        marcador: { p1: partida.puntosJugador1, p2: partida.puntosJugador2 }
    });

    if (movimientos[partida.id]) delete movimientos[partida.id];

    if (partida.puntosJugador1 >= 3 || partida.puntosJugador2 >= 3) {
        partida.estado = 'finalizada';
        partida.ganadorId = (partida.puntosJugador1 >= 3) ? partida.jugador1Id : partida.jugador2Id;
        await partida.save();

        const j1 = await User.findByPk(partida.jugador1Id);
        j1.partidasJugadas++;
        if (ganadorRonda === 1) j1.partidasGanadas++;
        await j1.save();

        if (partida.tipo === 'humano') {
            const j2 = await User.findByPk(partida.jugador2Id);
            j2.partidasJugadas++;
            if (ganadorRonda === 2) j2.partidasGanadas++;
            await j2.save();
        }

        io.to(`partida_${partida.id}`).emit('fin_partida', {
            ganador: (ganadorRonda === 1) ? 'Jugador 1' : (partida.tipo === 'cpu' ? 'CPU' : 'Jugador 2')
        });

        // 3. ACTUALIZAR RANKING AL ACABAR PARTIDA
        enviarRanking(io);
    }
}

// ESTA ES LA FUNCIÓN QUE FALTABA
async function enviarRanking(io) {
    try {
        const users = await User.findAll();
        const ranking = users.map(u => ({
            user: u.username,
            wins: u.partidasGanadas,
            total: u.partidasJugadas,
            pct: u.partidasJugadas > 0 ? ((u.partidasGanadas / u.partidasJugadas) * 100).toFixed(1) : "0.0"
        }));
        
        // Ordenar y enviar Top 10
        io.emit('ranking_actualizado', ranking.sort((a, b) => b.pct - a.pct).slice(0, 10));
    } catch (e) {
        console.error("Error ranking:", e);
    }
}

sequelize.sync({ force: false }).then(() => {
    console.log("Tablas sincronizadas correctamente");
    server.listen(3000, () => {
        console.log('Servidor corriendo en http://localhost:3000');
    });
}).catch(error => {
    console.error("Error al arrancar:", error);
});