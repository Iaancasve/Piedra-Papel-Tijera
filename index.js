const express = require('express');
const http = require('http'); 
const sequelize = require('./config/db');
const User = require('./models/User');
const Game = require('./models/Game');
const authRoutes = require('./routes/authRoutes');

const app = express();
const server = http.createServer(app); 


app.use(express.json()); 
app.use(express.static('public'));
app.use('/api/auth', authRoutes);


sequelize.sync({ force: false }) 
    .then(() => {
        console.log("Tablas sincronizadas correctamente");
        server.listen(3000, () => {
            console.log('Servidor corriendo en http://localhost:3000');
        });
    })
    .catch(error => {
        console.error("Error al sincronizar la base de datos:", error);
    });