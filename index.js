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

    (async () => {
        const partidaPendiente = await Game.findOne({
            where: {
                [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                estado: ['esperando', 'jugando']
            }
        });

        if (partidaPendiente) {
            // Volvemos a unir al socket a esa sala
            socket.join(`partida_${partidaPendiente.id}`);
            
            // Avisamos al cliente para que cambie la pantalla al juego directamente
            socket.emit('partida_en_curso', { 
                gameId: partidaPendiente.id, 
                tipo: partidaPendiente.tipo,
                estado: partidaPendiente.estado
            });
        }
    })();

    //SOLICITAR LISTA DE PARTIDAS
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

    // CREAR PARTIDA
    socket.on('crear_partida', async (tipo) => { // tipo será 'cpu' o 'humano'
        try {
        
            const partidaAbierta = await Game.findOne({
                where: {
                    [Op.or]: [{ jugador1Id: userId }, { jugador2Id: userId }],
                    estado: ['esperando', 'jugando']
                }
            });

            if (partidaAbierta) {
                return socket.emit('error', 'Ya tienes una partida en curso. Tienes que acabarla o abandonarla.');
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
                
                socket.emit('partida_empezada', { gameId: nuevaPartida.id, oponente: 'CPU' });
            }

        } catch (error) {
            console.error(error);
            socket.emit('error', 'Error al crear partida');
        }
    });

    // UNIRSE A PARTIDA
    socket.on('unirse_partida', async (gameId) => {
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

            const partida = await Game.findByPk(gameId);
            if (!partida || partida.estado !== 'esperando') {
                return socket.emit('error', 'Esa partida ya no está disponible');
            }

            // Actualizar partida
            partida.jugador2Id = userId;
            partida.estado = 'jugando';
            await partida.save();

            // Unir a sala
            socket.join(`partida_${gameId}`);

            
            io.to(`partida_${gameId}`).emit('partida_empezada', { gameId: gameId, oponente: 'Humano' });

            
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
                
                
                let ganadorId = null;
                if (partida.jugador1Id === userId) {
                    ganadorId = partida.jugador2Id; 
                } else {
                    ganadorId = partida.jugador1Id; 
                }
                
                partida.ganadorId = ganadorId;
                await partida.save();

                
                io.to(`partida_${partida.id}`).emit('partida_terminada', { 
                    mensaje: 'El oponente ha abandonado la partida. ¡Ganaste!' 
                });
                
                
                socket.leave(`partida_${partida.id}`);
                
                
                socket.emit('abandono_exitoso');
            }
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${username}`);
    });
});


sequelize.sync({ force: false }).then(() => {
    console.log("Tablas sincronizadas correctamente");
    server.listen(3000, () => {
        console.log('Servidor corriendo en http://localhost:3000');
    });
}).catch(error => {
    console.error("Error al arrancar:", error);
});