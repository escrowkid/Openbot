<?php
/**
 * Openbot — PHP proxy for cPanel / Apache hosts.
 *
 * Routes (via .htaccess rewriting /api/* -> api.php?action=*):
 *   POST /api/validate     { provider, apiKey }                  -> JSON
 *   POST /api/models       { provider, apiKey }                  -> JSON
 *   POST /api/chat         { provider, apiKey, model, messages,
 *                            attachments?, system? }             -> SSE
 *   GET  /api/providers                                          -> JSON
 *
 * Requirements: PHP 8.0+ and the curl extension.
 */

declare(strict_types=1);
error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
@set_time_limit(0);
@ignore_user_abort(false);

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'openrouter'];
const DEFAULT_MODELS = [
    'openai'     => ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4-turbo'],
    'anthropic'  => ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
    'gemini'     => ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    'groq'       => ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    'deepseek'   => ['deepseek-chat', 'deepseek-reasoner'],
    'openrouter' => ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
];

if (!function_exists('curl_init')) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'PHP curl extension is required but not enabled on this host']);
    exit;
}

$action = $_GET['action'] ?? '';
if ($action === 'ping') {
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'runtime' => 'php', 'php' => PHP_VERSION]);
    exit;
}
if ($action === 'providers') {
    header('Content-Type: application/json');
    echo json_encode([
        'providers' => array_map(
            fn($id) => ['id' => $id, 'defaultModels' => DEFAULT_MODELS[$id]],
            PROVIDERS
        ),
    ]);
    exit;
}

$raw  = file_get_contents('php://input');
$body = $raw ? (json_decode($raw, true) ?: []) : [];

switch ($action) {
    case 'validate': route_validate($body); break;
    case 'models':   route_models($body);   break;
    case 'chat':     route_chat($body);     break;
    default:
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'unknown action: ' . $action]);
}

/* =========================================================================
 *  Routes
 * ========================================================================= */

function route_validate(array $body): void {
    header('Content-Type: application/json');
    $provider = (string)($body['provider'] ?? '');
    $key      = trim((string)($body['apiKey'] ?? ''));
    if (!$provider || !$key) {
        http_response_code(400);
        echo json_encode(['live' => false, 'error' => 'provider and apiKey required']);
        return;
    }
    if (!in_array($provider, PROVIDERS, true)) {
        echo json_encode(['live' => false, 'error' => 'unknown provider']);
        return;
    }
    $fn = "validate_$provider";
    try {
        echo json_encode($fn($key));
    } catch (Throwable $e) {
        echo json_encode(['live' => false, 'error' => $e->getMessage()]);
    }
}

function route_models(array $body): void {
    header('Content-Type: application/json');
    $provider = (string)($body['provider'] ?? '');
    $key      = trim((string)($body['apiKey'] ?? ''));
    if (!in_array($provider, PROVIDERS, true)) {
        http_response_code(400);
        echo json_encode(['models' => []]);
        return;
    }
    $models = [];
    if ($key) {
        $fn = "models_$provider";
        try { $models = $fn($key); } catch (Throwable $e) { $models = []; }
    }
    if (empty($models)) $models = DEFAULT_MODELS[$provider];
    echo json_encode(['models' => $models]);
}

function route_chat(array $body): void {
    $provider    = (string)($body['provider'] ?? '');
    $key         = trim((string)($body['apiKey'] ?? ''));
    $model       = (string)($body['model'] ?? '');
    $messages    = $body['messages'] ?? null;
    $attachments = $body['attachments'] ?? [];
    $system      = isset($body['system']) ? (string)$body['system'] : null;

    if (!$provider || !$key || !$model || !is_array($messages)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'provider, apiKey, model, messages[] required']);
        return;
    }
    if (!in_array($provider, PROVIDERS, true)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'unknown provider']);
        return;
    }

    sse_init();
    $fn = "chat_$provider";
    try {
        $fn($key, $model, $messages, is_array($attachments) ? $attachments : [], $system);
    } catch (Throwable $e) {
        sse_send(['error' => $e->getMessage()]);
    }
}

/* =========================================================================
 *  SSE helpers
 * ========================================================================= */

function sse_init(): void {
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) @ob_end_flush();
    @ob_implicit_flush(true);
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('X-Accel-Buffering: no');
    header('Connection: keep-alive');
}

function sse_send(array $payload): void {
    echo 'data: ' . json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n\n";
    @flush();
}

/* =========================================================================
 *  HTTP helpers
 * ========================================================================= */

function http_get(string $url, array $headers = []): array {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($body === false) return ['code' => 0, 'body' => '', 'error' => $err];
    return ['code' => $code, 'body' => (string)$body];
}

function http_post_json(string $url, array $headers, $body): array {
    $payload = is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_SLASHES);
    $hdr = array_merge($headers, ['Content-Type: application/json']);
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_HTTPHEADER     => $hdr,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => (string)$resp];
}

/**
 * Stream an upstream SSE response. For each `data: ...` line, $on_data is called.
 * If upstream returns >= 400, the body is accumulated in error_body for caller.
 *
 * Returns ['code' => int, 'error_body' => string]
 */
function stream_sse(string $url, array $headers, string $body_json, callable $on_data, string $method = 'POST'): array {
    $ch = curl_init();
    $buffer = '';
    $err_body = '';
    $http_code = 0;

    $hdr = array_merge($headers, ['Content-Type: application/json', 'Accept: text/event-stream']);
    $opts = [
        CURLOPT_URL            => $url,
        CURLOPT_HTTPHEADER     => $hdr,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_TIMEOUT        => 0,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_HEADERFUNCTION => function ($ch, $h) use (&$http_code) {
            if (preg_match('#^HTTP/[\d.]+\s+(\d+)#', $h, $m)) $http_code = (int)$m[1];
            return strlen($h);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$buffer, &$err_body, $on_data, &$http_code) {
            if (connection_aborted()) return 0;
            if ($http_code >= 400) {
                // accumulate so caller can produce an error message
                $err_body .= $chunk;
                return strlen($chunk);
            }
            $buffer .= $chunk;
            while (($pos = strpos($buffer, "\n")) !== false) {
                $line = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 1);
                $line = rtrim($line, "\r");
                if (strncmp($line, 'data:', 5) === 0) {
                    $on_data(trim(substr($line, 5)));
                }
            }
            return strlen($chunk);
        },
    ];
    if ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = $body_json;
    }
    curl_setopt_array($ch, $opts);
    curl_exec($ch);
    curl_close($ch);

    // flush any final partial data: line
    if ($http_code < 400 && strncmp($buffer, 'data:', 5) === 0) {
        $on_data(trim(substr($buffer, 5)));
    }
    return ['code' => $http_code, 'error_body' => $err_body];
}

/* =========================================================================
 *  Attachments  -> provider-specific message shape
 * ========================================================================= */

function attach_to_last_user(array $messages, array $attachments, string $mode): array {
    if (empty($attachments)) return $messages;

    $idx = null;
    for ($i = count($messages) - 1; $i >= 0; $i--) {
        if (($messages[$i]['role'] ?? '') === 'user') { $idx = $i; break; }
    }
    if ($idx === null) return $messages;

    $text_blobs = [];
    $images = [];
    foreach ($attachments as $a) {
        if (isset($a['text']) && $a['text'] !== null) {
            $text_blobs[] = "\n\n[Attached file: " . ($a['name'] ?? '') . "]\n```\n" . (string)$a['text'] . "\n```\n";
        } elseif (!empty($a['dataUrl']) && isset($a['type']) && strncmp($a['type'], 'image/', 6) === 0) {
            $images[] = $a;
        }
    }

    $orig = $messages[$idx]['content'] ?? '';
    $base_text = (is_string($orig) ? $orig : '') . implode('', $text_blobs);

    if ($mode === 'openai') {
        if (!empty($images)) {
            $parts = [['type' => 'text', 'text' => $base_text !== '' ? $base_text : ' ']];
            foreach ($images as $img) {
                $parts[] = ['type' => 'image_url', 'image_url' => ['url' => $img['dataUrl']]];
            }
            $messages[$idx]['content'] = $parts;
        } else {
            $messages[$idx]['content'] = $base_text;
        }
    } elseif ($mode === 'anthropic') {
        $parts = [];
        foreach ($images as $img) {
            if (preg_match('#^data:([^;]+);base64,(.+)$#', (string)$img['dataUrl'], $m)) {
                $parts[] = ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $m[1], 'data' => $m[2]]];
            }
        }
        if ($base_text !== '') $parts[] = ['type' => 'text', 'text' => $base_text];
        $messages[$idx]['content'] = empty($parts) ? ($base_text !== '' ? $base_text : ' ') : $parts;
    } elseif ($mode === 'gemini') {
        $messages[$idx]['__text'] = $base_text;
        $messages[$idx]['__images'] = $images;
    }
    return $messages;
}

/* =========================================================================
 *  OpenAI
 * ========================================================================= */

function validate_openai(string $key): array {
    $r = http_get('https://api.openai.com/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => $r['code'] === 401 ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    return ['live' => true];
}

function models_openai(string $key): array {
    $r = http_get('https://api.openai.com/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = array_map(fn($m) => $m['id'] ?? '', $j['data'] ?? []);
    $ids = array_values(array_filter($ids, fn($id) => preg_match('/^(gpt-|o1|o3|o4|chatgpt)/i', $id)));
    sort($ids);
    return $ids;
}

function chat_openai_compat(string $base_url, string $key, string $model, array $messages, array $attachments, ?string $system): void {
    $msgs = attach_to_last_user($messages, $attachments, 'openai');
    if ($system) array_unshift($msgs, ['role' => 'system', 'content' => $system]);

    $body = json_encode(['model' => $model, 'messages' => $msgs, 'stream' => true], JSON_UNESCAPED_SLASHES);
    $r = stream_sse(
        "$base_url/chat/completions",
        ["Authorization: Bearer $key"],
        $body,
        function ($data) {
            if ($data === '[DONE]') return;
            $j = json_decode($data, true);
            if (!is_array($j)) return;
            $delta = $j['choices'][0]['delta']['content'] ?? null;
            if (is_string($delta) && $delta !== '') sse_send(['delta' => $delta]);
        }
    );
    if ($r['code'] >= 400) {
        sse_send(['error' => "HTTP {$r['code']}: " . substr($r['error_body'], 0, 300)]);
    } else {
        sse_send(['done' => true]);
    }
}

function chat_openai(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    chat_openai_compat('https://api.openai.com/v1', $key, $model, $messages, $attachments, $system);
}

/* =========================================================================
 *  Anthropic
 * ========================================================================= */

function validate_anthropic(string $key): array {
    $r = http_get('https://api.anthropic.com/v1/models', [
        "x-api-key: $key",
        "anthropic-version: 2023-06-01",
    ]);
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => $r['code'] === 401 ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    return ['live' => true];
}

function models_anthropic(string $key): array {
    $r = http_get('https://api.anthropic.com/v1/models', [
        "x-api-key: $key",
        "anthropic-version: 2023-06-01",
    ]);
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = array_map(fn($m) => $m['id'] ?? '', $j['data'] ?? []);
    $ids = array_values(array_filter($ids, fn($id) => $id !== ''));
    sort($ids);
    return $ids;
}

function chat_anthropic(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    $msgs = attach_to_last_user($messages, $attachments, 'anthropic');
    $mapped = array_map(fn($m) => [
        'role' => ($m['role'] ?? 'user') === 'assistant' ? 'assistant' : 'user',
        'content' => $m['content'] ?? '',
    ], $msgs);

    $payload = ['model' => $model, 'max_tokens' => 4096, 'stream' => true, 'messages' => $mapped];
    if ($system) $payload['system'] = $system;

    $r = stream_sse(
        'https://api.anthropic.com/v1/messages',
        ["x-api-key: $key", "anthropic-version: 2023-06-01"],
        json_encode($payload, JSON_UNESCAPED_SLASHES),
        function ($data) {
            $j = json_decode($data, true);
            if (!is_array($j)) return;
            $type = $j['type'] ?? '';
            if ($type === 'content_block_delta' && ($j['delta']['type'] ?? '') === 'text_delta') {
                sse_send(['delta' => $j['delta']['text']]);
            } elseif ($type === 'error') {
                sse_send(['error' => $j['error']['message'] ?? 'anthropic error']);
            }
        }
    );
    if ($r['code'] >= 400) {
        sse_send(['error' => "HTTP {$r['code']}: " . substr($r['error_body'], 0, 300)]);
    } else {
        sse_send(['done' => true]);
    }
}

/* =========================================================================
 *  Google Gemini
 * ========================================================================= */

function validate_gemini(string $key): array {
    $r = http_get('https://generativelanguage.googleapis.com/v1beta/models?key=' . urlencode($key));
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => ($r['code'] === 400 || $r['code'] === 403) ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    return ['live' => true];
}

function models_gemini(string $key): array {
    $r = http_get('https://generativelanguage.googleapis.com/v1beta/models?key=' . urlencode($key));
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = [];
    foreach ($j['models'] ?? [] as $m) {
        if (in_array('generateContent', $m['supportedGenerationMethods'] ?? [], true)) {
            $name = preg_replace('#^models/#', '', $m['name'] ?? '');
            if ($name) $ids[] = $name;
        }
    }
    sort($ids);
    return $ids;
}

function chat_gemini(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    $msgs = attach_to_last_user($messages, $attachments, 'gemini');
    $last_idx = count($msgs) - 1;
    $contents = [];
    foreach ($msgs as $i => $m) {
        $is_last_user = ($i === $last_idx) && ($m['role'] === 'user') && isset($m['__images']);
        $parts = [];
        if ($is_last_user) {
            if (!empty($m['__text'])) $parts[] = ['text' => $m['__text']];
            foreach (($m['__images'] ?? []) as $img) {
                if (preg_match('#^data:([^;]+);base64,(.+)$#', (string)$img['dataUrl'], $mm)) {
                    $parts[] = ['inline_data' => ['mime_type' => $mm[1], 'data' => $mm[2]]];
                }
            }
        } else {
            $txt = is_string($m['content'] ?? '') ? $m['content'] : ($m['__text'] ?? '');
            $parts[] = ['text' => (string)$txt];
        }
        $contents[] = [
            'role'  => ($m['role'] ?? 'user') === 'assistant' ? 'model' : 'user',
            'parts' => $parts,
        ];
    }
    $payload = ['contents' => $contents];
    if ($system) $payload['systemInstruction'] = ['parts' => [['text' => $system]]];

    $url = 'https://generativelanguage.googleapis.com/v1beta/models/'
         . urlencode($model)
         . ':streamGenerateContent?alt=sse&key=' . urlencode($key);

    $r = stream_sse(
        $url,
        [],
        json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        function ($data) {
            $j = json_decode($data, true);
            if (!is_array($j)) return;
            foreach ($j['candidates'][0]['content']['parts'] ?? [] as $p) {
                if (!empty($p['text'])) sse_send(['delta' => $p['text']]);
            }
        }
    );
    if ($r['code'] >= 400) {
        sse_send(['error' => "HTTP {$r['code']}: " . substr($r['error_body'], 0, 300)]);
    } else {
        sse_send(['done' => true]);
    }
}

/* =========================================================================
 *  Groq  (OpenAI-compatible)
 * ========================================================================= */

function validate_groq(string $key): array {
    $r = http_get('https://api.groq.com/openai/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => $r['code'] === 401 ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    return ['live' => true];
}

function models_groq(string $key): array {
    $r = http_get('https://api.groq.com/openai/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = array_map(fn($m) => $m['id'] ?? '', $j['data'] ?? []);
    $ids = array_values(array_filter($ids, fn($id) => $id !== ''));
    sort($ids);
    return $ids;
}

function chat_groq(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    chat_openai_compat('https://api.groq.com/openai/v1', $key, $model, $messages, $attachments, $system);
}

/* =========================================================================
 *  DeepSeek  (OpenAI-compatible + /user/balance)
 * ========================================================================= */

function validate_deepseek(string $key): array {
    $r = http_get('https://api.deepseek.com/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => $r['code'] === 401 ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    $balance = null;
    $b = http_get('https://api.deepseek.com/user/balance', ["Authorization: Bearer $key"]);
    if ($b['code'] === 200) {
        $bj = json_decode($b['body'], true) ?: [];
        $info = $bj['balance_infos'][0] ?? null;
        if ($info) $balance = trim(($info['currency'] ?? '') . ' ' . ($info['total_balance'] ?? ''));
    }
    return $balance ? ['live' => true, 'balance' => $balance] : ['live' => true];
}

function models_deepseek(string $key): array {
    $r = http_get('https://api.deepseek.com/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = array_map(fn($m) => $m['id'] ?? '', $j['data'] ?? []);
    $ids = array_values(array_filter($ids, fn($id) => $id !== ''));
    sort($ids);
    return $ids;
}

function chat_deepseek(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    chat_openai_compat('https://api.deepseek.com/v1', $key, $model, $messages, $attachments, $system);
}

/* =========================================================================
 *  OpenRouter
 * ========================================================================= */

function validate_openrouter(string $key): array {
    $r = http_get('https://openrouter.ai/api/v1/auth/key', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) {
        return ['live' => false, 'error' => $r['code'] === 401 ? 'Invalid API key' : "HTTP {$r['code']}: " . substr($r['body'] ?? '', 0, 120)];
    }
    $j = json_decode($r['body'], true) ?: [];
    $d = $j['data'] ?? [];
    $balance = null;
    if (isset($d['limit'], $d['usage'])) {
        $remaining = (float)$d['limit'] - (float)$d['usage'];
        $balance = '$' . number_format($remaining, 4, '.', '') . ' left';
    } elseif (isset($d['usage'])) {
        $balance = '$' . number_format((float)$d['usage'], 4, '.', '') . ' used';
    }
    return $balance ? ['live' => true, 'balance' => $balance] : ['live' => true];
}

function models_openrouter(string $key): array {
    $r = http_get('https://openrouter.ai/api/v1/models', ["Authorization: Bearer $key"]);
    if ($r['code'] !== 200) return [];
    $j = json_decode($r['body'], true) ?: [];
    $ids = array_map(fn($m) => $m['id'] ?? '', $j['data'] ?? []);
    $ids = array_values(array_filter($ids, fn($id) => $id !== ''));
    sort($ids);
    return $ids;
}

function chat_openrouter(string $key, string $model, array $messages, array $attachments, ?string $system): void {
    chat_openai_compat('https://openrouter.ai/api/v1', $key, $model, $messages, $attachments, $system);
}
