// =============================================
//  Poe Adapter v3 — Browser-side mock of window.Poe
//
//  Provides window.Poe.sendUserMessage() and
//  window.Poe.registerHandler() that route through
//  the Vercel proxy. Content is CUMULATIVE in
//  handler calls, matching native Poe API spec.
//
//  v3 changes:
//  - Sends 'complete' to handler even if stream was empty
//  - Sends 'error' if fetch fails or stream has no events
//  - Health check: window.Poe._checkHealth()
// =============================================
(function () {
  'use strict';

  // Skip if native Poe API is already present (running inside Poe iframe)
  if (window.Poe && typeof window.Poe.sendUserMessage === 'function') return;

  var config = window.POE_ADAPTER_CONFIG || {};
  var proxyUrl = config.proxyUrl || '/api/poe-proxy';
  var debug = !!config.debug;

  function log() {
    if (!debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[PoeAdapter]');
    console.log.apply(console, args);
  }

  // ---- Handler registry ----
  var handlers = {};

  function registerHandler(name, func) {
    handlers[name] = func;
    log('registerHandler:', name);
  }

  // ---- Parse @botName from text ----
  function parseBotName(text) {
    var m = text.match(/^@([\w\-._]+)\s*/);
    if (m) return { botName: m[1], cleanText: text.slice(m[0].length) };
    return { botName: null, cleanText: text };
  }

  // ---- SSE parser helper ----
  function parseSSE(chunk, onEvent) {
    var lines = chunk.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('data: ')) {
        var raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw));
        } catch (_) { /* skip malformed JSON */ }
      }
    }
  }

  // ---- sendUserMessage ----
  async function sendUserMessage(text, options) {
    options = options || {};
    var handlerName = options.handler || null;
    var shouldStream = options.stream !== false;
    var handlerContext = options.handlerContext || {};
    var parameters = options.parameters || {};

    var parsed = parseBotName(text);
    var botName = parsed.botName;
    var cleanText = parsed.cleanText;

    if (!botName) {
      throw { message: 'No @bot mention found in message', errorType: 'INVALID_INPUT' };
    }

    log('sendUserMessage → @' + botName, '| handler=' + handlerName, '| stream=' + shouldStream);

    var body = {
      botName: botName,
      message: cleanText,
      stream: shouldStream,
      parameters: parameters
    };

    // ---- Make the fetch request ----
    var response;
    try {
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      var fetchErr = { message: 'Network error: ' + (e.message || 'Failed to fetch'), errorType: 'UNKNOWN' };
      // Also notify handler of the error so the UI can update
      if (handlerName && handlers[handlerName]) {
        handlers[handlerName]({
          status: 'error',
          responses: [{
            messageId: '', senderId: botName, content: '',
            contentType: 'text/markdown', status: 'error',
            statusText: fetchErr.message
          }]
        }, handlerContext);
      }
      throw fetchErr;
    }

    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch (_) { /* noop */ }
      var proxyErr = { message: 'Proxy error ' + response.status + ': ' + errText, errorType: 'UNKNOWN' };
      // Notify handler
      if (handlerName && handlers[handlerName]) {
        handlers[handlerName]({
          status: 'error',
          responses: [{
            messageId: '', senderId: botName, content: '',
            contentType: 'text/markdown', status: 'error',
            statusText: proxyErr.message
          }]
        }, handlerContext);
      }
      throw proxyErr;
    }

    // ---- Parse SSE stream and dispatch to handler ----
    if (handlerName && handlers[handlerName]) {
      var handler = handlers[handlerName];
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var sseBuffer = '';
      var eventCount = 0;
      var gotComplete = false;
      var lastContent = '';

      // Read SSE chunks
      while (true) {
        var result;
        try {
          result = await reader.read();
        } catch (readErr) {
          handler({
            status: 'error',
            responses: [{
              messageId: '', senderId: botName, content: lastContent,
              contentType: 'text/markdown', status: 'error',
              statusText: 'Stream read error: ' + (readErr.message || 'Unknown')
            }]
          }, handlerContext);
          break;
        }

        if (result.done) break;
        sseBuffer += decoder.decode(result.value, { stream: true });

        // Split on double-newline (SSE event boundary)
        var eventChunks = sseBuffer.split('\n\n');
        sseBuffer = eventChunks.pop() || '';

        for (var ci = 0; ci < eventChunks.length; ci++) {
          parseSSE(eventChunks[ci], function (evt) {
            eventCount++;
            log('SSE event #' + eventCount + ':', evt.status, '| content length:', (evt.content || '').length);

            var msg = {
              messageId: evt.messageId || '',
              senderId: evt.senderId || botName,
              content: evt.content || '',
              contentType: evt.contentType || 'text/markdown',
              status: evt.status || 'incomplete',
              statusText: evt.statusText || undefined,
              attachments: evt.attachments || undefined
            };

            if (evt.content) lastContent = evt.content;
            if (evt.status === 'complete') gotComplete = true;

            handler({
              status: evt.status || 'incomplete',
              responses: [msg]
            }, handlerContext);
          });
        }
      }

      // Flush remaining SSE buffer
      if (sseBuffer.trim()) {
        parseSSE(sseBuffer, function (evt) {
          eventCount++;
          var msg = {
            messageId: evt.messageId || '',
            senderId: evt.senderId || botName,
            content: evt.content || '',
            contentType: evt.contentType || 'text/markdown',
            status: evt.status || 'complete',
            statusText: evt.statusText || undefined,
            attachments: evt.attachments || undefined
          };
          if (evt.content) lastContent = evt.content;
          if (evt.status === 'complete' || !evt.status) gotComplete = true;
          handler({
            status: evt.status || 'complete',
            responses: [msg]
          }, handlerContext);
        });
      }

      // CRITICAL: If stream ended but handler never got a 'complete' event,
      // send one now so the caller's Promise resolves
      if (!gotComplete) {
        log('Stream ended without complete event. eventCount=' + eventCount + ', sending synthetic complete.');
        if (eventCount === 0) {
          // No events at all — proxy returned empty/broken response
          handler({
            status: 'error',
            responses: [{
              messageId: '', senderId: botName, content: '',
              contentType: 'text/markdown', status: 'error',
              statusText: 'Proxy returned empty response — check deployment and environment variables at /api/health'
            }]
          }, handlerContext);
        } else {
          // Had some events but no explicit complete — send complete with last known content
          handler({
            status: 'complete',
            responses: [{
              messageId: '', senderId: botName, content: lastContent,
              contentType: 'text/markdown', status: 'complete'
            }]
          }, handlerContext);
        }
      }

      log('Stream finished. Events:', eventCount, '| gotComplete:', gotComplete);
    }

    return { success: true };
  }

  // ---- getTriggerMessage stub ----
  async function getTriggerMessage() {
    return {
      messageId: '', senderId: '', content: '',
      contentType: 'text/plain', status: 'complete', attachments: []
    };
  }

  // ---- captureCost stub ----
  async function captureCost(amounts, options) {
    if (options && options.logChargeOutcome) {
      for (var i = 0; i < amounts.length; i++) {
        var a = amounts[i];
        console.log('Creator-defined paid event: ' + (a.description || 'charge') + ' | ' + a.amountUsdMilliCents + ' milli-cents');
      }
    }
    return { success: true };
  }

  // ---- Health check ----
  async function checkHealth() {
    var base = proxyUrl.replace(/\/api\/poe-proxy\/?$/, '');
    var url = base + '/api/health';
    try {
      var res = await fetch(url);
      var data = await res.json();
      console.log('[PoeAdapter] Health check:', JSON.stringify(data));
      return data;
    } catch (e) {
      console.error('[PoeAdapter] Health check FAILED:', e.message);
      return { status: 'unreachable', error: e.message };
    }
  }

  // ---- Expose API ----
  window.Poe = {
    sendUserMessage: sendUserMessage,
    registerHandler: registerHandler,
    getTriggerMessage: getTriggerMessage,
    captureCost: captureCost,
    _checkHealth: checkHealth
  };

  log('Poe Adapter v3 initialized | proxy:', proxyUrl);

  // Auto health check on load (non-blocking)
  if (debug) {
    setTimeout(function() { checkHealth(); }, 1000);
  }
})();
