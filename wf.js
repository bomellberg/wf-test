#!/usr/bin/env node
'use strict';
// Wordfeud API test — login + list active games
// Usage: WF_EMAIL=you@example.com WF_PASSWORD=secret node wf.js

var https = require('https');
var http  = require('http');
var tls   = require('tls');
var url   = require('url');
var crypto = require('crypto');

var WF_HOST = 'api.wordfeud.com';

var BASE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'WebFeudClient/3.0.0 (Android 7)',
  'Accept': 'application/json',
};

// Simple cookie jar
var cookieJar = {};

function buildCookieHeader() {
  return Object.keys(cookieJar).map(function(k) { return k + '=' + cookieJar[k]; }).join('; ');
}

function updateCookieJar(resHeaders) {
  var setCookie = resHeaders['set-cookie'];
  if (!setCookie) return;
  var cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (var i = 0; i < cookies.length; i++) {
    var pair = cookies[i].split(';')[0];
    var eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      cookieJar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
}

function hashPassword(password) {
  // Wordfeud uses SHA1(password + "JarJarBinks9") as the salted hash
  return crypto.createHash('sha1').update(password + 'JarJarBinks9').digest('hex');
}

// ---------------------------------------------------------------------------
// HTTP CONNECT proxy agent (picks up https_proxy / HTTPS_PROXY env vars)
// ---------------------------------------------------------------------------
var _agent = null;

function getAgent() {
  if (_agent) return _agent;

  var proxyStr = process.env.https_proxy || process.env.HTTPS_PROXY ||
                 process.env.http_proxy  || process.env.HTTP_PROXY  || '';

  if (!proxyStr) {
    _agent = new https.Agent();
    return _agent;
  }

  var p = url.parse(proxyStr);
  var proxyHost = p.hostname;
  var proxyPort = parseInt(p.port, 10) || 8080;
  console.log('Proxy: ' + proxyHost + ':' + proxyPort);

  // Override createConnection to tunnel through an HTTP CONNECT proxy.
  // Node's http.Agent.createSocket() checks: if createConnection() returns
  // undefined it waits for the callback, so fully async is fine.
  _agent = new https.Agent({ keepAlive: false });
  _agent.createConnection = function(options, cb) {
    var target = (options.hostname || options.host) + ':' + options.port;
    var connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: target,
      agent: false,
      headers: { 'Host': target, 'Proxy-Connection': 'keep-alive' },
    });

    connectReq.once('connect', function(res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error('Proxy CONNECT failed: HTTP ' + res.statusCode));
        return;
      }
      var tlsSock = tls.connect({
        socket: socket,
        servername: options.hostname || options.host,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      }, function() { cb(null, tlsSock); });
      tlsSock.on('error', cb);
    });
    connectReq.once('error', cb);
    connectReq.end();
    // return undefined — callback will fire asynchronously
  };

  return _agent;
}

// ---------------------------------------------------------------------------

function wfRequest(method, path, body) {
  return new Promise(function(resolve, reject) {
    var bodyStr = body ? JSON.stringify(body) : '';
    var cookie = buildCookieHeader();
    var headers = Object.assign({}, BASE_HEADERS);
    if (cookie) headers['Cookie'] = cookie;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    var options = {
      hostname: WF_HOST,
      port: 443,
      path: path,
      method: method,
      headers: headers,
      agent: getAgent(),
    };

    var req = https.request(options, function(res) {
      updateCookieJar(res.headers);
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(method + ' ' + path + ' -> HTTP ' + res.statusCode + ': ' + data));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON parse error: ' + data));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function wfPost(path, body) {
  return wfRequest('POST', path, body || {});
}

function wfGet(path) {
  return wfRequest('GET', path, null);
}

// ---------------------------------------------------------------------------
// Tile sets — { LETTER: count } per ruleset id.
// '?' = blank tile.
// ---------------------------------------------------------------------------
var TILE_SETS = {
  0: {A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1,'?':2}, // English US
  1: {A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1,'?':2}, // English UK
  2: {A:9,B:2,C:1,D:5,E:8,F:2,G:3,H:2,I:5,J:1,K:3,L:5,M:3,N:6,O:6,P:2,R:8,S:8,T:9,U:3,V:2,X:1,Y:1,Z:1,'\u00C5':2,'\u00C4':2,'\u00D6':2,'?':2}, // Swedish (104)
  3: {A:7,B:3,D:5,E:9,F:4,G:4,H:3,I:5,J:2,K:4,L:5,M:3,N:6,O:4,P:2,R:6,S:6,T:6,U:3,V:4,Y:1,'\u00C6':2,'\u00D8':2,'\u00C5':2,'?':2}, // Norwegian
  4: {A:9,B:2,C:1,D:5,E:8,F:2,G:3,H:2,I:5,J:1,K:3,L:5,M:3,N:6,O:6,P:2,R:8,S:8,T:9,U:3,V:2,X:1,Y:1,Z:1,'\u00C5':2,'\u00C4':2,'\u00D6':2,'?':2}, // Swedish server 4 (104)
  5: {A:6,B:2,C:3,D:5,E:18,F:2,G:3,H:2,I:4,J:1,K:3,L:5,M:3,N:10,O:6,P:2,Q:1,R:6,S:5,T:5,U:6,V:2,W:2,X:1,Y:1,Z:2,'?':2}, // Dutch
};

function getTileSet(ruleset) {
  return TILE_SETS[ruleset] || TILE_SETS[0];
}

// Compute letters not yet placed on the board (still in bag + both racks).
// tiles  — array from game.tiles, each entry [x, y, letter, is_wildcard]
//          OR {x, y, character, is_wildcard} — we handle both.
// rack   — my rack: array of letter strings or tile objects (may be absent)
function computeRemaining(tileSet, tiles, rack) {
  var remaining = {};
  Object.keys(tileSet).forEach(function(l) { remaining[l] = tileSet[l]; });

  function subtract(letter, wildcard) {
    var key = wildcard ? '?' : letter.toUpperCase();
    if (remaining[key] !== undefined) remaining[key] = Math.max(0, remaining[key] - 1);
  }

  // Board tiles
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (Array.isArray(t)) subtract(t[2], t[3]);          // [x, y, letter, is_wildcard]
    else subtract(t.character || t.letter || '', t.is_wildcard);
  }

  // My rack (already known to us — subtract so we see only bag + opponent rack)
  for (var j = 0; j < (rack || []).length; j++) {
    var r = rack[j];
    if (typeof r === 'string') subtract(r, r === '?');
    else subtract(r.character || r.letter || '', r.is_wildcard);
  }

  return remaining;
}

function formatRemaining(remaining) {
  var out = [];
  Object.keys(remaining).sort().forEach(function(l) {
    for (var i = 0; i < remaining[l]; i++) out.push(l);
  });
  return out.join('');
}

// Extract rack letters from a player object — tries known field names.
// Returns sorted array of uppercase letter strings (blank = '?').
function extractRack(player) {
  if (!player) return [];
  var raw = player.rack || player.tiles || player.hand || [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    if (typeof r === 'string') out.push(r === '' ? '?' : r.toUpperCase());
    else if (Array.isArray(r)) out.push(r[0] ? r[0].toUpperCase() : '?');
    else out.push(r.is_wildcard ? '?' : (r.character || r.letter || '?').toUpperCase());
  }
  return out.sort();
}

// ---------------------------------------------------------------------------

function login(email, password) {
  console.log('Logging in as ' + email + ' ...');
  var passwordHash = hashPassword(password);
  return wfPost('/wf/user/login/email/', { email: email, password: passwordHash });
}

function getCurrentGames() {
  return wfGet('/wf/user/games/');
}

// ---------------------------------------------------------------------------

function printGames(games, myId) {
  if (!games.length) {
    console.log('  (no active games)');
    return;
  }
  for (var i = 0; i < games.length; i++) {
    var g = games[i];
    var me = null, opp = null;
    for (var j = 0; j < g.players.length; j++) {
      if (g.players[j].id === myId) me = g.players[j];
      else opp = g.players[j];
    }
    var myPos = me ? me.position : -1;
    var myTurn = g.current_player === myPos;
    var myScore = me ? me.score : 0;
    var oppScore = opp ? opp.score : 0;
    var oppName = opp ? opp.username : '?';
    var status = g.is_running ? (myTurn ? 'YOUR TURN  ' : 'waiting    ') : 'finished   ';

    var boardTiles = g.tiles || [];
    var myRack    = extractRack(me);
    var tileSet   = getTileSet(g.ruleset);

    // remaining = bag + opponent rack (board tiles and my rack subtracted)
    var rem = computeRemaining(tileSet, boardTiles, myRack);

    var myStr  = myRack.length ? myRack.join('') : '(unknown)';
    var remStr = formatRemaining(rem);

    console.log(
      '  [' + g.id + ']  ' + status + '  vs ' + oppName +
      '  score ' + myScore + '-' + oppScore + '\n' +
      '           my tiles : ' + myStr + '\n' +
      '           bag+opp  : ' + remStr + '  (bag:' + g.bag_count + ')'
    );
  }
}

function main() {
  var email = process.env.WF_EMAIL;
  var password = process.env.WF_PASSWORD;

  if (!email || !password) {
    console.error('Usage: WF_EMAIL=<email> WF_PASSWORD=<password> node wf.js');
    process.exit(1);
  }

  login(email, password)
    .then(function(loginRes) {
      if (loginRes.status !== 'success') {
        console.error('Login failed:', JSON.stringify(loginRes, null, 2));
        process.exit(1);
      }
      var me = loginRes.content;
      console.log('Logged in:  ' + me.username + '  (id ' + me.id + ')');

      console.log('Fetching current games ...\n');
      return getCurrentGames().then(function(gamesRes) {
        if (gamesRes.status !== 'success') {
          console.error('Failed to fetch games:', JSON.stringify(gamesRes, null, 2));
          process.exit(1);
        }
        var games = (gamesRes.content && gamesRes.content.games) ? gamesRes.content.games : [];
        console.log('Games: ' + games.length + '\n');
        printGames(games, me.id);

        if (process.env.WF_DEBUG) {
          console.log('\n--- first game raw ---');
          console.log(JSON.stringify(games[0], null, 2));
        }
      });
    })
    .catch(function(err) {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

main();

