/* Require */
let process = require('process');
process.env = require('./env.js'); // hacky implementation

let nanoid;
(async()=>{
  const nanid = await import('nanoid');
  nanoid = nanid.nanoid;
})();

const PORT = 3000;
const Express = require('express')
const bodyParser = require('body-parser');
const cors = require('cors');
const htms = require('server-htms');
const app = Express();

const { Client, Events, GatewayIntentBits, Partials, ChannelType, AttachmentBuilder } = require('discord.js');

const server = process.env['server'];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel
  ]
});

client.once(Events.ClientReady, readyClient => {
  console.log(`Bot logged in as ${readyClient.user.tag}`);
});

client.login(process.env['token']);

/* Databases */
const { DB } = require("fshdb")

const files = new DB('./databases/files.json')
const share = new DB('./databases/share.json')

/* Errors */
process.on('uncaughtException', function(err) {
  console.log('Error!');
  console.log(err);
});

/* Useful functions*/
function getCookie(req, name) {
  let cookies = req.headers.cookie;
  name += '=';
  cookies = String(cookies)
    .split(' ')
    .filter(cookie => cookie.startsWith(name))[0]
    ?.split(';')[0]
    ?.split('=')[1];
  return cookies ?? '';
}
let tokenCache = {};
async function getUser(req) {
  let cook = getCookie(req, 'FshAccountToken');
  if (!cook) return;
  if (tokenCache[cook]) return tokenCache[cook];
  let res = await fetch('https://account.fsh.plus/api/me', { headers: { cookie: 'FshAccountToken='+cook } });
  if (!res.ok) return;
  res = await res.json();
  tokenCache[cook] = res.id;
  return res.id;
}
function encrypt(file, id) {
  let key = (86 + id) % 256;
  for (let i = 0; i < file.length; i++) {
    file[i] = 255 - (file[i] ^ key);
  }
  return file;
}

app.use(cors());
app.use(bodyParser.urlencoded({
  extended: true,
  limit: '25mb'
}));
app.use(bodyParser.raw({
  type: '*/*',
  limit: '25mb'
}));
app.use(bodyParser.json({
  limit: '25mb'
}));
app.use(htms)
app.use(function(req, res, next) {
  let orig = res.send;
  function mod(text) {
    return text.replace(/\{\{[^¬]+?\}\}/g, function(match){
      let re;
      try {
        re = eval(match.replace('{{','').replace('}}','').trim());
      } catch (err) {
        re = 'Error';
        console.log('Err: '+err)
      }
      return re;
    })
  }
  res.send = function(){
    if (typeof arguments[0] === 'string') {
      arguments[0] = mod(arguments[0]);
    }
    orig.apply(res, arguments)
  };
  next();
})

app.get('/', async function(req, res) {
  if (!await getUser(req)) {
    res.htms('pages/login.html')
  } else {
    let u = await getUser(req);
    if (!files.has(u)) {
      files.set(u, []);
    }
    res.htms('pages/index.html')
  }
})
app.get('/share', async function(req, res) {
  if (!req.query['id']) res.redirect('/');
  if (!share.has(req.query['id'])) res.redirect('/');
  let sh = share.get(req.query['id']);
  let usr = files.find(u=>u.filter(f=>f.channel===sh.channel&&f.message===sh.message)[0])[0];
  if (!usr) {
    share.remove(req.query['id']);
    res.redirect('/');
    return;
  }
  let file = files.get(usr).filter(f=>f.channel===sh.channel&&f.message===sh.message)[0];
  let message = await client.guilds.cache.get(server).channels.cache.get(sh.channel)?.messages?.fetch(sh.message);
  if (!message) {
    share.remove(req.query['id']);
    res.redirect('/');
    return;
  }
  fetch(message.attachments.first().url)
    .then(async re => {
      re = await re.arrayBuffer();
      re = encrypt(Buffer.from(re), usr);
      res.status(200)
      res.set('content-type', file.type);
      res.set('content-disposition', 'inline; filename="'+file.name+'"');
      res.send(re)
    })
})

/* API */
app.get('/api/files', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  res.json(files.get(await getUser(req)))
})
app.post('/api/upload', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  if (!req.body) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Include file'
    })
    return;
  }
  let user = await getUser(req);
  let channel = await client.guilds.cache.get(server).channels.cache.find(channel => channel.name === 'f'+user);
  if (!channel) {
    channel = await client.guilds.cache.get(server).channels.create({
      name: "f"+user,
      type: ChannelType.GuildText
    })
  }
  let attachment = new AttachmentBuilder(encrypt(Buffer.from(req.body), user), { name: req.query['name'].length ? req.query['name'] : 'file' });

  let msg = await channel.send({
    files: [attachment]
  })
  files.push(user, {
    name: req.query['name'].length ? req.query['name'] : 'file',
    type: (req.query['type'] || ''),
    size: req.body.length,
    message: msg.id,
    channel: channel.id
  })
  res.status(200)
  res.json({})
})
app.get('/api/download', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  if (!req.query['m'] || !req.query['c']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing identifiers'
    })
    return;
  }
  let user = await getUser(req);
  if (!files.get(user).filter(f=>f.channel===req.query['c']&&f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let message = await client.guilds.cache.get(server).channels.cache.get(req.query['c']).messages.fetch(req.query['m']);
  if (!message) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let file = files.get(user).filter(f=>f.channel===req.query['c']&&f.message===req.query['m'])[0];
  fetch(message.attachments.first().url)
    .then(async re => {
      re = await re.arrayBuffer();
      re = encrypt(Buffer.from(re), user);
      res.status(200)
      res.set('content-type', file.type);
      res.set('content-disposition', 'attachment; filename="'+file.name+'"');
      res.send(re)
    })
})
app.post('/api/rename', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  if (!req.query['m'] || !req.query['c']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing identifiers'
    })
    return;
  }
  if (!req.query['name']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing name'
    })
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.channel===req.query['c']&&f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let user = await getUser(req);
  let f = files.get(user);
  let c = req.query['c'];
  let m = req.query['m'];
  f = f.map(t => {
    if (t.channel === c && t.message === m) {
      t.name = req.query['name'];
      return t;
    } else {
      return t;
    }
  })
  files.set(user, f);
  res.json({})
})
app.post('/api/share', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  if (!req.query['m'] || !req.query['c']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing identifiers'
    })
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.channel===req.query['c']&&f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let past = share.find(s=>s.channel===req.query['c']&&s.message===req.query['m'])[0];
  if (past) {
    res.json({
      link: share.get(past).link
    })
    return;
  }
  let id = nanoid(100)
  let link = await fetch(`https://link.fsh.plus/create?url=${encodeURIComponent(`https://storage.fsh.plus/share?id=${id}`)}&time=0&uses=0`, { method: 'POST' });
  link = await link.json();
  share.set(id, {
    message: req.query['m'],
    channel: req.query['c'],
    link: link.url+'+'
  })

  res.json({
    link: link.url+'+'
  })
})
app.post('/api/delete', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    })
    return;
  }
  if (!req.query['m'] || !req.query['c']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing identifiers'
    })
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.channel===req.query['c']&&f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let message = await client.guilds.cache.get(server).channels.cache.get(req.query['c']).messages.fetch(req.query['m']);
  if (!message) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  await message.delete();
  files.set(await getUser(req), files.get(await getUser(req)).filter(f=>f.channel!==req.query['c']||f.message!==req.query['m']))
  res.json({});
})

// 404
app.use(function(req, res) {
  res.status(404)
  res.htms('pages/404.html')
})

app.listen(PORT, ()=>{console.clear();console.log('Server online at '+PORT)});
