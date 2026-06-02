/* Require */
let process = require('node:process');
process.env = require('./env.js'); // hacky implementation

let nanoid;
(async()=>{
  const nanid = await import('nanoid');
  nanoid = nanid.nanoid;
})();

const Express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('node:path');
const htms = require('server-htms');
const app = Express();

const { Blob } = require('node:buffer');

/* Databases */
const DB = require("fshdb");

const files = new DB('./databases/files.json');
const share = new DB('./databases/share.json');

const MaxSize = 100*1024*1024;
const MaxSizeStr = '100mb';
const ChunkSize = 10*1024*1024;

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
async function getMessage(chid, msgid, action='GET') {
  let message = await fetch(`https://discord.com/api/v10/channels/${chid}/messages/${msgid}`, {
    method: action,
    headers: {
      authorization: 'Bot '+process.env['token']
    }
  });
  if (action==='GET') message = await message.json()
  return message;
}

app.use(cors());
app.use(bodyParser.urlencoded({
  extended: true,
  limit: MaxSizeStr
}));
app.use(bodyParser.raw({
  type: '*/*',
  limit: MaxSizeStr
}));
app.use(bodyParser.json({
  limit: MaxSizeStr
}));
app.use(htms);
app.use(function(req, res, next) {
  let orig = res.send;
  function mod(text) {
    return text.replace(/\{\{[^¬]+?\}\}/g, function(match){
      let re;
      try {
        re = eval(match.replace('{{','').replace('}}','').trim());
      } catch (err) {
        re = 'Error';
        console.log('Err: ', err)
      }
      return re;
    })
  }
  res.send = function(){
    if (typeof arguments[0] === 'string') {
      arguments[0] = mod(arguments[0]);
    }
    orig.apply(res, arguments);
  };
  next();
});

app.use('/media', Express.static('media'));

app.get('/favicon.ico', async function(req, res) {
  res.sendFile(path.join(__dirname, 'pages/favicon.ico'));
});
app.get('/', async function(req, res) {
  if (!await getUser(req)) {
    res.htms('pages/login.html');
  } else {
    let u = await getUser(req);
    if (!files.has(u)) {
      files.set(u, []);
    }
    res.htms('pages/index.html');
  }
});
app.get('/share', async function(req, res) {
  if (!req.query['id']) {
    res.redirect('/');
    return;
  }
  if (!share.has(req.query['id'])) {
    res.redirect('/');
    return;
  }
  let sh = share.get(req.query['id']);
  if (!sh.message) {
    res.redirect('/');
    return;
  }
  let usr = files.find(u=>u.filter(f=>f.message===sh.message)[0])[0];
  if (!usr) {
    share.remove(req.query['id']);
    res.redirect('/');
    return;
  }
  let file = files.get(usr).filter(f=>f.message===sh.message)[0];
  let message;
  try {
    message = await getMessage((sh.channel??process.env.channel), sh.message);
  } catch(err) {
    share.remove(req.query['id']);
    res.redirect('/');
    return;
  }
  if (!message) {
    share.remove(req.query['id']);
    res.redirect('/');
    return;
  }

  res.status(200);
  res.set('Content-Type', file.type);
  res.set('Transfer-Encoding', 'chunked');
  res.set('Accept-Ranges', 'none');
  res.set('Content-Disposition', `inline; filename="${file.name}"`);

  for (let i = 0; i<message.attachments.length; i++) {
    let f = await fetch(message.attachments[i].url);
    for await (const chunk of f.body) {
      res.write(encrypt(chunk, usr));
    }
  }
  res.end();
});

/* API */
app.get('/api/files', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  res.json(files.get(await getUser(req)));
});
app.post('/api/upload', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  if (!req.body) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Include file'
    });
    return;
  }
  if (req.body.length > MaxSize) {
    res.status(413);
    res.json({
      err: true,
      msg: 'File too big'
    });
    return;
  }
  let user = await getUser(req);
  let buf;
  try {
    buf = Buffer.from(req.body);
  } catch(err) {
    res.status(400);
    res.json({
      err: true,
      msg: 'Invalid file content'
    });
    return;
  }
  let enc = encrypt(buf, user);
  let formData = new FormData();
  for (let i = 0; i<enc.length; i+=ChunkSize) {
    formData.append(`file[${i/ChunkSize}]`, new Blob([enc.slice(i, i+ChunkSize)], { type: 'text/plain' }), 'file.bin');
  }
  let msg;
  try {
    msg = await fetch(`https://discord.com/api/v10/channels/${process.env.channel}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bot '+process.env['token']
      },
      body: formData
    });
    msg = await msg.json();
  } catch(err) {
    res.status(500);
    res.json({
      err: true,
      msg: 'Could not upload'
    });
    return;
  }
  if (!msg.id) {
    res.status(500);
    res.json({
      err: true,
      msg: 'No file reference'
    });
    return;
  }
  files.push(user, {
    name: req.query['name'].length ? req.query['name'] : 'file',
    type: (req.query['type'] ?? ''),
    size: req.body.length,
    message: msg.id
  });
  res.status(200);
  res.json({});
});
app.get('/api/download', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401)
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  if (!req.query['m']) {
    res.status(400)
    res.json({
      err: true,
      msg: 'Missing identifier'
    });
    return;
  }
  let user = await getUser(req);
  if (!files.get(user).filter(f=>f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let message = await getMessage(req.query['c']??process.env.channel, req.query['m']);
  if (!message) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let file = files.get(user).filter(f=>f.message===req.query['m'])[0];

  res.set('Content-Type', file.type);
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Disposition', `attachment; filename="${file.name}"`);

  let range = [0, message.attachments.length];
  let byteRange = [0, file.size];
  if (req.headers.range&&(/^bytes=[0-9]*?-[0-9]*?$/).test(req.headers.range)) {
    let match = req.headers.range.match(/^bytes=([0-9]*?)-([0-9]*?)$/);
    if (match[1]) {
      byteRange[0] = Number(match[1]);
      range[0] = Math.floor(byteRange[0]/ChunkSize);
    }
    if (match[2]) {
      byteRange[1] = Math.min(Number(match[2])+1, file.size);
      range[1] = Math.min(Math.floor((byteRange[1]-1)/ChunkSize)+1, message.attachments.length);
    }
  }

  if (range[0]!==0||range[1]!==message.attachments.length) {
    res.status(206);
    res.set('Content-Length', byteRange[1]-byteRange[0]);
    res.set('Content-Range', `bytes ${byteRange[0]}-${byteRange[1]-1}/${file.size}`);
  } else {
    res.status(200);
    res.set('Content-Length', file.size);
  }

  for (let i = range[0]; i<range[1]; i++) {
    let f = await fetch(message.attachments[i].url);
    let size = 0;
    let stcut = i!==range[0];
    for await (const chunk of f.body) {
      let data = encrypt(chunk, user);
      if (i===range[0]&&byteRange[0]%ChunkSize!==0) {
        if (size+data.length<=byteRange[0]%ChunkSize) {
          size += data.length;
          continue;
        }
        if (size+data.length>byteRange[0]%ChunkSize&&!stcut) {
          stcut = true;
          data = data.slice(byteRange[0]%ChunkSize-size);
        }
      }
      if (i===range[1]-1&&byteRange[1]%ChunkSize!==0) {
        if (size+data.length>byteRange[1]%ChunkSize) {
          data = data.slice(0, byteRange[1]%ChunkSize-size);
          res.write(data);
          res.end();
          return;
        }
      }
      size += data.length;
      res.write(data);
    }
  }
  res.end();
});
app.post('/api/rename', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401);
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  if (!req.query['m']) {
    res.status(400);
    res.json({
      err: true,
      msg: 'Missing identifier'
    });
    return;
  }
  if (!req.query['name']) {
    res.status(400);
    res.json({
      err: true,
      msg: 'Missing name'
    });
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let user = await getUser(req);
  let f = files.get(user);
  let m = req.query['m'];
  f = f.map(t => {
    if (t.message === m) {
      t.name = req.query['name'];
    }
    return t;
  })
  files.set(user, f);
  res.json({});
});
app.post('/api/share', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401);
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  if (!req.query['m']) {
    res.status(400);
    res.json({
      err: true,
      msg: 'Missing identifiers'
    });
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let past = share.find(s=>s.message===req.query['m'])[0];
  if (past) {
    res.json({
      link: share.get(past).link
    });
    return;
  }
  let id = nanoid(60);
  let link = await fetch(`https://link.fsh.plus/create?url=${encodeURIComponent(`https://storage.fsh.plus/share?id=${id}`)}&time=0&uses=0`, { method: 'POST' });
  link = await link.json();
  let data = {
    message: req.query['m'],
    link: link.url+'+'
  };
  if (req.query['c']) data.channel = req.query['c'];
  share.set(id, data);

  res.json({
    link: link.url+'+'
  });
});
app.post('/api/delete', async function(req, res) {
  if (!await getUser(req)) {
    res.status(401);
    res.json({
      err: true,
      msg: 'Not logged in'
    });
    return;
  }
  if (!req.query['m']) {
    res.status(400);
    res.json({
      err: true,
      msg: 'Missing identifiers'
    });
    return;
  }
  if (!files.get(await getUser(req)).filter(f=>f.message===req.query['m'])[0]) {
    res.status(404);
    res.json({
      err: true,
      msg: 'Could not find file'
    });
    return;
  }
  let message = await getMessage(req.query['c']??process.env.channel, req.query['m'], 'DELETE');
  files.set(await getUser(req), files.get(await getUser(req)).filter(f=>f.message!==req.query['m']));
  res.json({});
});

// 404
app.use(function(req, res) {
  res.status(404);
  res.htms('pages/404.html');
});

app.listen(process.env['port'], ()=>{
  console.clear();
  console.log('Server online at '+process.env['port']);
});