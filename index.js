const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');
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
    console.log(`Usuario conectado: ${socket.user.username}`);

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.user.username}`);
    });
});

sequelize.sync({ force: false }).then(() => {
    console.log("Tablas sincronizadas");
    server.listen(3000, () => {
        console.log('Servidor corriendo en http://localhost:3000');
    });
});