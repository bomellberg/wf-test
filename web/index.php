<?php
// ============================================================
//  Wordfeud game viewer — no PHP sessions (localStorage-based)
// ============================================================
define('WF_HOST',  'api.wordfeud.com');
define('WF_AGENT', 'WebFeudClient/3.0.0 (Android 7)');

// WF session ID from browser localStorage (sent as POST field — no PHP session cookie needed)
$WF_SID  = isset($_POST['wf_sid'])       ? trim($_POST['wf_sid'])       : '';
$wf_user = !empty($_POST['wf_user_json']) ? (json_decode($_POST['wf_user_json'], true) ?: null) : null;

// Swedish tile set (104 tiles, ruleset 4)
$TILESET = [
    'A'=>9,'B'=>2,'C'=>1,'D'=>5,'E'=>8,'F'=>2,'G'=>3,'H'=>2,'I'=>5,'J'=>1,
    'K'=>3,'L'=>5,'M'=>3,'N'=>6,'O'=>6,'P'=>2,'R'=>8,'S'=>8,'T'=>9,'U'=>3,
    'V'=>2,'X'=>1,'Y'=>1,'Z'=>1,'Å'=>2,'Ä'=>2,'Ö'=>2,'?'=>2,
];
$LETTER_ORDER = ['?','A','B','C','D','E','F','G','H','I','J','K','L','M',
                 'N','O','P','Q','R','S','T','U','V','W','X','Y','Z','Å','Ä','Ö'];
$TILE_VALUES = [
    'A'=>1,'B'=>4,'C'=>8,'D'=>2,'E'=>1,'F'=>4,'G'=>3,'H'=>3,'I'=>1,'J'=>8,
    'K'=>3,'L'=>2,'M'=>3,'N'=>1,'O'=>2,'P'=>4,'R'=>1,'S'=>1,'T'=>1,'U'=>4,
    'V'=>4,'X'=>8,'Y'=>7,'Z'=>8,'Å'=>4,'Ä'=>4,'Ö'=>8,'?'=>0,
];

// ── API helpers ──────────────────────────────────────────────
function wf_request(string $method, string $path, ?array $data = null): ?array {
    global $WF_SID;
    $ch = curl_init('https://' . WF_HOST . $path);
    $hdrs = [
        'Content-Type: application/json',
        'Accept: application/json',
        'User-Agent: ' . WF_AGENT,
    ];
    if (!empty($WF_SID)) {
        $hdrs[] = 'Cookie: sessionid=' . $WF_SID;
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_HTTPHEADER     => $hdrs,
        CURLOPT_TIMEOUT        => 15,
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST,       true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data ?? new stdClass()));
    }
    $raw = curl_exec($ch);
    $hsz = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    if ($raw === false) return null;

    $header = substr($raw, 0, $hsz);
    $body   = substr($raw, $hsz);
    if (preg_match('/Set-Cookie:\s*sessionid=([^;\s]+)/i', $header, $m)) {
        $WF_SID = $m[1];
    }
    return json_decode($body, true);
}
function wf_post(string $p, array $d): ?array { return wf_request('POST', $p, $d); }
function wf_get(string $p): ?array            { return wf_request('GET',  $p); }

// ── Tile helpers ─────────────────────────────────────────────
function extract_rack(?array $player): array {
    if (!$player) return [];
    $raw = $player['rack'] ?? $player['tiles'] ?? $player['hand'] ?? [];
    $out = [];
    foreach ($raw as $r) {
        if (is_string($r))                            $out[] = $r === '' ? '?' : mb_strtoupper($r);
        elseif (!empty($r['is_wildcard']))             $out[] = '?';
        else                                          $out[] = mb_strtoupper($r['character'] ?? $r['letter'] ?? '?');
    }
    sort($out);
    return $out;
}

function compute_remaining(array $tileSet, array $boardTiles, array $myRack): array {
    $rem = $tileSet;
    foreach ($boardTiles as $t) {
        $key = is_array($t) && isset($t[3])
            ? ($t[3] ? '?' : mb_strtoupper($t[2]))
            : (!empty($t['is_wildcard']) ? '?' : mb_strtoupper($t['character'] ?? $t['letter'] ?? ''));
        if (isset($rem[$key])) $rem[$key] = max(0, $rem[$key] - 1);
    }
    foreach ($myRack as $l) {
        $key = $l === '?' ? '?' : mb_strtoupper($l);
        if (isset($rem[$key])) $rem[$key] = max(0, $rem[$key] - 1);
    }
    return $rem;
}

function sorted_letters(array $rem, array $order): array {
    $out = [];
    foreach ($order as $l) {
        if (!isset($rem[$l])) continue;
        for ($i = 0; $i < $rem[$l]; $i++) $out[] = $l;
    }
    return $out;
}

function tile_html(string $l, bool $small = false): string {
    global $TILE_VALUES;
    $cls = 'tile' . ($small ? ' sm' : '') . ($l === '?' ? ' blank' : '');
    $ch  = $l === '?' ? '' : htmlspecialchars($l);
    $val = $TILE_VALUES[$l] ?? 0;
    return "<div class=\"$cls\">$ch<span class=\"val\">$val</span></div>";
}

// ── Routing ──────────────────────────────────────────────────
if (isset($_GET['logout'])) {
    header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
    exit;
}

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['email'])) {
    if (!function_exists('curl_init')) {
        $error = 'PHP cURL extension is not installed. Run: apt install php8.3-curl';
    } else {
        $hash = sha1($_POST['password'] . 'JarJarBinks9');
        $res  = wf_post('/wf/user/login/email/', [
            'email'    => trim($_POST['email']),
            'password' => $hash,
        ]);
        if ($res === null) {
            $error = 'Could not reach api.wordfeud.com — cURL failed. Check: apt install php8.3-curl';
        } elseif (($res['status'] ?? '') === 'success') {
            $url     = strtok($_SERVER['REQUEST_URI'], '?');
            $sid_js  = json_encode($WF_SID);
            $user_js = json_encode(json_encode($res['content'] ?? []));
            echo "<script>localStorage.setItem('wf_sid',$sid_js);localStorage.setItem('wf_user',$user_js);location.replace(" . json_encode($url) . ");</script>";
            exit;
        } else {
            $error = 'Login failed: ' . htmlspecialchars(json_encode($res));
        }
    }
}

$loggedIn   = !empty($WF_SID) && !empty($wf_user);
$authFailed = false;
$games      = [];
if ($loggedIn) {
    $gr = wf_get('/wf/user/games/');
    if (($gr['status'] ?? '') === 'success') {
        $games = $gr['content']['games'] ?? [];
    } else {
        $authFailed = true;
        $loggedIn   = false;
    }
}
$myId = (int)($wf_user['id'] ?? 0);

// Sort: your turn → waiting → finished
function game_order(array $g, int $id): int {
    if (!$g['is_running']) return 2;
    foreach ($g['players'] as $p)
        if ($p['id'] == $id) return $g['current_player'] === $p['position'] ? 0 : 1;
    return 1;
}
usort($games, fn($a, $b) => game_order($a, $myId) - game_order($b, $myId));
?>
<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Wordfeud</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#121212;color:#e0e0e0;min-height:100vh}

/* ── Header ── */
header{background:#1e1e2e;padding:13px 18px;display:flex;justify-content:space-between;
       align-items:center;position:sticky;top:0;z-index:10;
       box-shadow:0 2px 10px #0009}
header h1{font-size:20px;color:#89b4fa;letter-spacing:1px}
.hdr-right{display:flex;gap:8px;align-items:center}
.user{font-size:13px;color:#7f849c}
.btn{background:none;border:1px solid #45475a;color:#cdd6f4;padding:6px 14px;
     border-radius:8px;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
.btn:hover{border-color:#89b4fa;color:#89b4fa}

/* ── Cards ── */
.games{padding:16px;display:flex;flex-direction:column;gap:12px;
       max-width:600px;margin:0 auto}
.card{background:#1e1e2e;border-radius:14px;padding:16px;
      border-left:4px solid #45475a}
.card.your-turn{border-left-color:#a6e3a1}
.card.finished{opacity:.4}

.card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.opp{font-size:18px;font-weight:700}
.score{font-size:14px;color:#a6adc8;margin-top:3px}
.badge{font-size:11px;font-weight:800;padding:4px 11px;border-radius:20px;
       text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;margin-top:2px}
.badge.your-turn{background:#a6e3a1;color:#1e1e2e}
.badge.waiting{background:#313244;color:#7f849c}
.badge.finished{background:#181825;color:#585b70}

/* ── Tiles ── */
.section{margin-top:10px}
.lbl{font-size:10px;color:#7f849c;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.tiles{display:flex;flex-wrap:wrap;gap:4px;min-height:20px}

.tile{width:44px;height:44px;background:#fff;color:#1e1e2e;font-weight:800;
      font-size:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 0 #aaa,0 3px 5px #0003;position:relative}
.tile.blank{background:#fff;color:#1e1e2e;box-shadow:0 2px 0 #aaa,0 3px 5px #0003}
.tile.sm{width:34px;height:34px;font-size:16px;font-weight:700;border-radius:4px;
         box-shadow:0 1px 0 #aaa,0 2px 4px #0002}
.tile.sm.blank{box-shadow:0 1px 0 #aaa,0 2px 4px #0002}
.tile .val{position:absolute;bottom:2px;right:3px;font-size:8px;font-weight:600;line-height:1;color:#777}

.bag-info{font-size:11px;color:#45475a;margin-top:8px}

/* ── Login ── */
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.login-box{background:#1e1e2e;border-radius:18px;padding:36px 28px;width:100%;max-width:340px}
.login-box h2{margin-bottom:26px;color:#89b4fa;text-align:center;font-size:24px}
.login-box input{width:100%;padding:14px 16px;margin-bottom:14px;background:#313244;
                 border:1px solid #45475a;border-radius:10px;color:#cdd6f4;font-size:16px}
.login-box input:focus{outline:none;border-color:#89b4fa}
.login-box button{width:100%;padding:14px;background:#89b4fa;color:#1e1e2e;
                  border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:4px}
.login-box button:hover{background:#b4d0ff}
.err{color:#f38ba8;font-size:13px;margin-bottom:14px;text-align:center}
</style>
</head>
<body>

<?php if (!$loggedIn): ?>
<div class="login">
  <div class="login-box">
    <h2>Wordfeud</h2>
    <?php if ($error): ?><p class="err"><?= htmlspecialchars($error) ?></p><?php endif ?>
    <form method="post" autocomplete="on">
      <input type="email"    name="email"    placeholder="Email"    required autocomplete="email">
      <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
      <button type="submit">Login</button>
    </form>
  </div>
</div>

<?php else: ?>
<header>
  <h1>Wordfeud</h1>
  <div class="hdr-right">
    <span class="user"><?= htmlspecialchars($wf_user['username'] ?? '') ?></span>
    <button class="btn" onclick="location.href=location.pathname">↻</button>
    <a class="btn" href="#" onclick="localStorage.removeItem('wf_sid');localStorage.removeItem('wf_user');location.href=location.pathname;return false;">Logout</a>
  </div>
</header>

<div class="games">
<?php foreach ($games as $g):
    $me = null; $opp = null;
    foreach ($g['players'] as $p) {
        if ($p['id'] == $myId) $me = $p; else $opp = $p;
    }
    $myScore  = $me['score']       ?? 0;
    $oppScore = $opp['score']      ?? 0;
    $oppName  = $opp['username']   ?? '?';
    $myTurn   = $g['is_running'] && $g['current_player'] === ($me['position'] ?? -1);
    $finished = !$g['is_running'];

    $cardCls  = $finished ? 'finished' : ($myTurn ? 'your-turn' : '');
    $badgeCls = $finished ? 'finished' : ($myTurn ? 'your-turn' : 'waiting');
    $badgeTxt = $finished ? 'Finished'  : ($myTurn ? 'Your turn'  : 'Waiting');

    $myRack  = extract_rack($me);
    $rem     = compute_remaining($TILESET, $g['tiles'] ?? [], $myRack);
    $remList = sorted_letters($rem, $LETTER_ORDER);
    $bagCnt  = (int)($g['bag_count'] ?? 0);
?>
<div class="card <?= $cardCls ?>">
  <div class="card-top">
    <div>
      <div class="opp"><?= htmlspecialchars($oppName) ?></div>
      <div class="score"><?= $myScore ?> – <?= $oppScore ?></div>
    </div>
    <span class="badge <?= $badgeCls ?>"><?= $badgeTxt ?></span>
  </div>

  <?php if ($myRack || $g['is_running']): ?>
  <div class="section">
    <div class="lbl">My tiles</div>
    <div class="tiles">
      <?php foreach ($myRack as $l) echo tile_html($l, true) ?>
    </div>
  </div>
  <?php endif ?>

  <div class="section">
    <div class="lbl">Bag + opponent</div>
    <div class="tiles">
      <?php foreach ($remList as $l) echo tile_html($l, true) ?>
    </div>
    <div class="bag-info"><?= count($remList) ?> tiles &middot; bag: <?= $bagCnt ?></div>
  </div>
</div>
<?php endforeach ?>
</div>

<script>setTimeout(function(){location.href=location.pathname},3*60*1000)</script>
<?php endif ?>

<form id="autoform" method="post" style="display:none">
  <input type="hidden" name="wf_sid" id="f_sid">
  <input type="hidden" name="wf_user_json" id="f_user">
</form>
<?php if ($authFailed): ?>
<script>localStorage.removeItem('wf_sid');localStorage.removeItem('wf_user');</script>
<?php elseif (!$loggedIn): ?>
<script>
(function(){
  var s=localStorage.getItem('wf_sid');
  if(s){document.getElementById('f_sid').value=s;document.getElementById('f_user').value=localStorage.getItem('wf_user')||'';document.getElementById('autoform').submit();}
})();
</script>
<?php endif ?>
</body>
</html>
