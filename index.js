const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const path = require('path');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const OWNERS = [
    "55119961453670",
    "55119919181954",
    "230167934947389",
    "263388902981733"
];

const MAX_KB = 1200;

const COLOR = {
    ok: '\x1b[38;5;110m',
    err: '\x1b[38;5;174m',
    reset: '\x1b[0m'
};

const log = {
    recv: t => console.log(`${COLOR.ok}[RECEIVED]${COLOR.reset}`, t),
    create: () => console.log(`${COLOR.ok}[CREATING]${COLOR.reset} Sticker`),
    created: kb => console.log(`${COLOR.ok}[CREATED]${COLOR.reset} ${kb.toFixed(1)} KB`),
    send: () => console.log(`${COLOR.ok}[SENDING]${COLOR.reset} Sticker`),
    sent: () => console.log(`${COLOR.ok}[SENT]${COLOR.reset} Sticker sent`),
    fail: e => console.log(`${COLOR.err}[FAILED]${COLOR.reset}`, e)
};

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "sticker-bot",
        dataPath: path.join(__dirname, ".wwebjs_auth")
    }),
    puppeteer: {
        headless: false,
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

const autoMode = new Set();
let MY_NUMBER = null;

function extractNumber(msg) {
    const id = msg.author || msg.from;
    if (!id) return null;
    return id.split('@')[0];
}

function isOwner(msg) {
    const num = extractNumber(msg);
    return OWNERS.includes(num);
}

async function convert(media, cfg) {
    const id = crypto.randomUUID();
    const input = path.join(__dirname, `${id}.input`);
    const output = path.join(__dirname, `${id}.webp`);

    fs.writeFileSync(input, Buffer.from(media.data, 'base64'));

    await new Promise((resolve, reject) => {
        ffmpeg(input)
            .outputOptions([
                `-t ${cfg.t}`,
                `-r ${cfg.fps}`,
                '-vcodec libwebp',
                '-vf scale=512:512:flags=lanczos',
                '-pix_fmt yuva420p',
                '-lossless 0',
                `-quality ${cfg.q}`,
                '-loop 0',
                '-an'
            ])
            .save(output)
            .on('end', resolve)
            .on('error', reject);
    });

    fs.unlinkSync(input);

    const sizeKB = fs.statSync(output).size / 1024;
    return { output, sizeKB };
}

async function generateAndSend(msg, media) {
    log.create();

    if (media.mimetype === 'image/png' || media.mimetype === 'image/webp') {
        try {
            const res = await convert(media, { t: 1, fps: 1, q: 90 });
            log.created(res.sizeKB);
            log.send();
            const sticker = MessageMedia.fromFilePath(res.output);
            await client.sendMessage(msg.from, sticker, {
                sendMediaAsSticker: true,
                stickerAuthor: config.stickerAuthor
            });
            fs.unlinkSync(res.output);
            log.sent();
            return true;
        } catch (e) {
            log.fail(e);
            return false;
        }
    }

    const attempts = [
        { t: 8, fps: 15, q: 70 },
        { t: 8, fps: 12, q: 60 },
        { t: 8, fps: 10, q: 50 },
        { t: 8, fps: 8,  q: 40 }
    ];

    for (const cfg of attempts) {
        let output;

        try {
            const res = await convert(media, cfg);
            output = res.output;

            log.created(res.sizeKB);

            if (res.sizeKB > MAX_KB) {
                fs.unlinkSync(output);
                continue;
            }

            log.send();

            const sticker = MessageMedia.fromFilePath(output);
            await client.sendMessage(msg.from, sticker, {
                sendMediaAsSticker: true,
                stickerAuthor: config.stickerAuthor
            });

            fs.unlinkSync(output);
            log.sent();
            return true;

        } catch (e) {
            if (output && fs.existsSync(output)) fs.unlinkSync(output);
            log.fail(e);
        }
    }

    return false;
}

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
    MY_NUMBER = client.info.wid._serialized.replace('@c.us', '');
    try {
        const ascii = fs.readFileSync('./ascii.txt', 'utf8');
        console.log(ascii);
    } catch {}
    console.log();
    console.log(`${COLOR.ok}[BOT] Connected and ready.${COLOR.reset}`);
});

client.on('message', async msg => {

    if (!isOwner(msg)) return;

    if (msg.body === '!on') {
        autoMode.add(msg.from);
        msg.reply('auto on');
        return;
    }

    if (msg.body === '!off') {
        autoMode.delete(msg.from);
        msg.reply('auto off');
        return;
    }

    if (autoMode.has(msg.from) && msg.hasMedia) {

        const media = await msg.downloadMedia();

        if (!media.mimetype.startsWith('image/') &&
            !media.mimetype.startsWith('video/')) {
            return;
        }

        const ok = await generateAndSend(msg, media);
        if (!ok) msg.reply('deu nkk');
        return;
    }

    if (msg.body !== '!s') return;

    let target = msg;
    if (msg.hasQuotedMsg) {
        target = await msg.getQuotedMessage();
    }

    if (!target.hasMedia) return;

    const media = await target.downloadMedia();

    if (!media.mimetype.startsWith('image/') &&
        !media.mimetype.startsWith('video/')) {
        return;
    }

    const ok = await generateAndSend(msg, media);
    if (!ok) msg.reply('deu nkk');
});

process.on('SIGINT', async () => {
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await client.destroy();
    process.exit(0);
});

client.initialize();

