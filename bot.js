// bot.js - Telegram Bot Handler
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Handle /start with startapp parameter (wallet return)
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const startapp = match?.[1]; // This contains the return data from wallet
    
    if (startapp) {
        console.log('User returned from wallet with startapp:', startapp);
        // The Mini App will handle the connection state
    }
    
    // Send the WebApp button
    bot.sendMessage(chatId, '🎮 Launch GoldHunt to mine GOLD!', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Launch GoldHunt',
                web_app: { url: process.env.APP_URL }
            }]]
        }
    });
});
