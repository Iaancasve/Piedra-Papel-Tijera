const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const Game = sequelize.define('Game', {
    tipo: {
        type: DataTypes.ENUM('cpu', 'humano'), 
        allowNull: false
    },
    estado: {
        type: DataTypes.ENUM('esperando', 'jugando', 'finalizada'),
        defaultValue: 'esperando' 
    },
    
    puntosJugador1: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    puntosJugador2: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    ganadorId: { 
        type: DataTypes.INTEGER,
        allowNull: true
    }
});


Game.belongsTo(User, { as: 'Jugador1', foreignKey: 'jugador1Id' });
Game.belongsTo(User, { as: 'Jugador2', foreignKey: 'jugador2Id' });

module.exports = Game;