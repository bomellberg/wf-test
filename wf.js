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

function login(email, password) {
  console.log('Logging in as ' + email + ' ...');
  var passwordHash = hashPassword(password);
  return wfPost('/wf/user/login/email/', { email: email, password: passwordHash });
}

var GAMES_CANDIDATES = [
  { method: 'GET',  path: '/wf/user/games/' },
  { method: 'POST', path: '/wf/user/games/' },
  { method: 'GET',  path: '/wf/user/get_games/' },
  { method: 'POST', path: '/wf/user/get_games/' },
  { method: 'GET',  path: '/wf/user/' },
  { method: 'POST', path: '/wf/user/get_current_games/' },
];

function getCurrentGames() {
  // Try each candidate in sequence; stop at the first that returns a non-404
  function tryNext(i) {
    if (i >= GAMES_CANDIDATES.length) {
      return Promise.reject(new Error('No working games endpoint found'));
    }
    var c = GAMES_CANDIDATES[i];
    var req = c.method === 'GET' ? wfGet(c.path) : wfPost(c.path);
    return req.then(function(res) {
      console.log('Games endpoint: ' + c.method + ' ' + c.path);
      return res;
    }).catch(function(err) {
      if (/404/.test(err.message)) return tryNext(i + 1);
      // Non-404 error (403, 500 etc.) — also skip but log it
      console.log('Skip ' + c.method + ' ' + c.path + ': ' + err.message.slice(0, 60));
      return tryNext(i + 1);
    });
  }
  return tryNext(0);
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
    console.log(
      '  [' + g.id + ']  ' + status + '  vs ' + oppName +
      '  score ' + myScore + '-' + oppScore +
      '  board: ' + g.board
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
      console.log('Cookies:    ' + buildCookieHeader() + '\n');

      console.log('Fetching current games ...');
      return getCurrentGames().then(function(gamesRes) {
        if (gamesRes.status !== 'success') {
          console.error('Failed to fetch games:', JSON.stringify(gamesRes, null, 2));
          process.exit(1);
        }
        var games = (gamesRes.content && gamesRes.content.games) ? gamesRes.content.games : [];
        console.log('Active games: ' + games.length + '\n');
        printGames(games, me.id);

        if (process.env.WF_DEBUG) {
          console.log('\n--- raw games response ---');
          console.log(JSON.stringify(gamesRes, null, 2));
        }
      });
    })
    .catch(function(err) {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

main();
