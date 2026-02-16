const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 дней
}));

// ==================== БАЗА ДАННЫХ ====================
let db;
(async () => {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    // Создание таблиц
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            credits INTEGER DEFAULT 10,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT NOT NULL,
            result_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            order_id TEXT UNIQUE NOT NULL,
            amount INTEGER DEFAULT 100,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        );
    `);
    console.log('✅ База данных подключена');
})();

// ==================== МИДЛВАР АВТОРИЗАЦИИ ====================
const authMiddleware = async (req, res, next) => {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Не авторизован' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
        const user = await db.get('SELECT id, username, email, credits FROM users WHERE id = ?', [decoded.id]);
        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Недействительный токен' });
    }
};

// ==================== API АВТОРИЗАЦИИ ====================
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.run(
            'INSERT INTO users (username, email, password, credits) VALUES (?, ?, ?, 10)',
            [username, email, hashedPassword]
        );

        const token = jwt.sign(
            { id: result.lastID },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '7d' }
        );

        res.cookie('token', token, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true, token, credits: 10 });
    } catch (error) {
        if (error.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Имя пользователя или email уже заняты' });
        } else {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        const token = jwt.sign(
            { id: user.id },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '7d' }
        );

        res.cookie('token', token, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true, token, credits: user.credits });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/user', authMiddleware, async (req, res) => {
    res.json({
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        credits: req.user.credits
    });
});

// ==================== AI ГЕНЕРАЦИЯ ====================
app.post('/api/generate/text', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user.id;

    if (req.user.credits < 1) {
        return res.status(403).json({ error: 'Недостаточно промптов' });
    }

    try {
        // Gemini API - бесплатно
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            }
        );

        const generatedText = response.data.candidates[0].content.parts[0].text;

        // Списываем промпт
        await db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);

        // Сохраняем в историю
        await db.run(
            'INSERT INTO generations (user_id, type, prompt, result_url) VALUES (?, ?, ?, ?)',
            [userId, 'text', prompt, generatedText.substring(0, 200) + '...']
        );

        res.json({ success: true, result: generatedText, credits: req.user.credits - 1 });
    } catch (error) {
        console.error('Gemini error:', error);
        res.status(500).json({ error: 'Ошибка генерации текста' });
    }
});

app.post('/api/generate/image', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user.id;

    if (req.user.credits < 1) {
        return res.status(403).json({ error: 'Недостаточно промптов' });
    }

    try {
        // Replicate API (Stable Diffusion)
        const response = await axios.post(
            'https://api.replicate.com/v1/predictions',
            {
                version: 'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
                input: { prompt: prompt }
            },
            {
                headers: {
                    'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Ждем результат
        let result = await waitForPrediction(response.data.urls.get, process.env.REPLICATE_API_TOKEN);
        const imageUrl = result.output[0];

        // Списываем промпт
        await db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);

        // Сохраняем в историю
        await db.run(
            'INSERT INTO generations (user_id, type, prompt, result_url) VALUES (?, ?, ?, ?)',
            [userId, 'image', prompt, imageUrl]
        );

        res.json({ success: true, result: imageUrl, credits: req.user.credits - 1 });
    } catch (error) {
        console.error('Image generation error:', error);
        res.status(500).json({ error: 'Ошибка генерации изображения' });
    }
});

app.post('/api/generate/video', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user.id;

    if (req.user.credits < 1) {
        return res.status(403).json({ error: 'Недостаточно промптов' });
    }

    try {
        // SiliconFlow API для Wan2.2
        const response = await axios.post(
            'https://api.siliconflow.com/v1/video/submit',
            {
                model: 'wan2.2-t2v',
                prompt: prompt,
                duration: 5
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Получаем результат
        const taskId = response.data.task_id;
        let videoUrl = await waitForVideo(taskId, process.env.SILICONFLOW_API_KEY);

        // Списываем промпт
        await db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);

        // Сохраняем в историю
        await db.run(
            'INSERT INTO generations (user_id, type, prompt, result_url) VALUES (?, ?, ?, ?)',
            [userId, 'video', prompt, videoUrl]
        );

        res.json({ success: true, result: videoUrl, credits: req.user.credits - 1 });
    } catch (error) {
        console.error('Video generation error:', error);
        res.status(500).json({ error: 'Ошибка генерации видео' });
    }
});

app.post('/api/generate/audio', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user.id;

    if (req.user.credits < 1) {
        return res.status(403).json({ error: 'Недостаточно промптов' });
    }

    try {
        // Здесь можно подключить API для генерации звука
        // Например, VoiceVox, ElevenLabs или локальную модель
        // В демо-версии возвращаем заглушку
        
        // Списываем промпт
        await db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);

        // Сохраняем в историю
        await db.run(
            'INSERT INTO generations (user_id, type, prompt, result_url) VALUES (?, ?, ?, ?)',
            [userId, 'audio', prompt, 'https://example.com/audio.mp3']
        );

        res.json({ 
            success: true, 
            result: 'https://example.com/audio.mp3', 
            credits: req.user.credits - 1 
        });
    } catch (error) {
        console.error('Audio generation error:', error);
        res.status(500).json({ error: 'Ошибка генерации аудио' });
    }
});

// Вспомогательные функции для AI
async function waitForPrediction(url, token) {
    let attempts = 0;
    while (attempts < 30) {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Token ${token}` }
        });
        if (response.data.status === 'succeeded') {
            return response.data;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
    }
    throw new Error('Timeout waiting for prediction');
}

async function waitForVideo(taskId, token) {
    let attempts = 0;
    while (attempts < 60) {
        const response = await axios.get(
            `https://api.siliconflow.com/v1/video/status/${taskId}`,
            {
                headers: { 'Authorization': `Bearer ${token}` }
            }
        );
        if (response.data.status === 'completed') {
            return response.data.video_url;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
    }
    throw new Error('Timeout waiting for video');
}

// ==================== ИСТОРИЯ ГЕНЕРАЦИЙ ====================
app.get('/api/generations', authMiddleware, async (req, res) => {
    try {
        const generations = await db.all(
            'SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
            [req.user.id]
        );
        res.json(generations);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения истории' });
    }
});

// ==================== ПЛАТЕЖИ ЧЕРЕЗ RuStore ====================
app.post('/api/create-payment', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const orderId = `order_${Date.now()}_${userId}`;

    try {
        // Сохраняем заказ в БД
        await db.run(
            'INSERT INTO payments (user_id, order_id, amount, status) VALUES (?, ?, ?, ?)',
            [userId, orderId, 100, 'pending']
        );

        // Здесь должен быть запрос к RuStore API для создания платежа
        // Документация: https://help.rustore.ru/rustore/for_business/oplata/rustore-pay/integratsiya-cherez-api
        const paymentUrl = `https://pay.rustore.ru/pay/${orderId}`; // Заглушка

        res.json({
            success: true,
            orderId: orderId,
            paymentUrl: paymentUrl
        });
    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: 'Ошибка создания платежа' });
    }
});

app.post('/api/check-payment', authMiddleware, async (req, res) => {
    const { orderId } = req.body;

    try {
        const payment = await db.get(
            'SELECT * FROM payments WHERE order_id = ? AND user_id = ?',
            [orderId, req.user.id]
        );

        if (!payment) {
            return res.status(404).json({ error: 'Платеж не найден' });
        }

        if (payment.status === 'paid') {
            return res.json({ success: true, status: 'paid' });
        }

        // Здесь проверка статуса через RuStore API
        // В демо-версии эмулируем успешную оплату
        await db.run(
            'UPDATE payments SET status = ? WHERE id = ?',
            ['paid', payment.id]
        );
        
        // Начисляем 1 промпт
        await db.run(
            'UPDATE users SET credits = credits + 1 WHERE id = ?',
            [req.user.id]
        );

        res.json({ success: true, status: 'paid' });
    } catch (error) {
        console.error('Payment check error:', error);
        res.status(500).json({ error: 'Ошибка проверки платежа' });
    }
});

// ==================== СТАТИЧЕСКИЕ СТРАНИЦЫ ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment.html')));

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});app.post('/api/generate/text', authMiddleware, async (req, res) => {
    // ... sk-or-v1-f68...a21 ...
});

// Защита от вылетов
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});