const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SECRET_KEY = 'mi_secreto_super_seguro'; 

exports.register = async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validación básica
        if (!username || !password) {
            return res.status(400).json({ error: "Faltan datos" });
        }

        // Encriptar contraseña
        const hashedPassword = await bcrypt.hash(password, 10);

        // Crear usuario
        const newUser = await User.create({
            username,
            password: hashedPassword
        });

        res.status(201).json({ message: "Usuario creado con éxito", userId: newUser.id });
    } catch (error) {
        
        res.status(400).json({ error: "Error al crear usuario. Posiblemente el nombre ya existe." });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;

        
        const user = await User.findOne({ where: { username } });
        if (!user) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
        }

        
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
        }

        
        const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });

        res.json({ message: "Login exitoso", token });
    } catch (error) {
        res.status(500).json({ error: "Error en el servidor" });
    }
};