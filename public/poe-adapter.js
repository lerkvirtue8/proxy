// =============================================
//  Poe Adapter v2 — Browser-side mock of window.Poe
//
//  When the app runs OUTSIDE Poe's native iframe
//  (e.g. in a browser via the proxy), this script
//  provides window.Poe.sendUserMessage() and
//  window.Poe.registerHandler() that route through
//  the proxy server and relay streamed responses.
//
//  KEY FIX: content is always CUMULATIVE in handler
//  calls, matching the native Poe API spec.
// =============================================
(function () {
  'use strict';

  // Skip if native Poe API is already present
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
        } catch (_) { /* skip */ }
      }
    }
  }

  // ---- sendUserMessage ----
  async function sendUserMessage(text, options) {
    options = options || {};
    var handlerName = options.handler || null;
    var shouldStream = options.stream !== false;
    var openChat = options.openChat !== false;
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

    var response;
    try {
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw { message: 'Network error: ' + (e.message || 'Failed to fetch'), errorType: 'UNKNOWN' };
    }

    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch (_) { /* noop */ }
      throw { message: 'Proxy error ' + response.status + ': ' + errText, errorType: 'UNKNOWN' };
    }

    // ---- Parse SSE stream and dispatch to handler ----
    if (handlerName && handlers[handlerName]) {
      var handler = handlers[handlerName];
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var sseBuffer = '';
      var lastStatus = 'incomplete';

      // Read SSE chunks
      while (true) {
        var result;
        try {
          result = await reader.read();
        } catch (readErr) {
          // Stream read error — send error event to handler
          handler({
            status: 'error',
            responses: [{
              messageId: '',
              senderId: botName,
              content: '',
              contentType: 'text/markdown',
              status: 'error',
              statusText: 'Stream read error: ' + (readErr.message || 'Unknown')
            }]
          }, handlerContext);
          break;
        }

        if (result.done) break;
        sseBuffer += decoder.decode(result.value, { stream: true });

        // Split on double-newline (SSE event boundary) or single newline for data lines
        var eventChunks = sseBuffer.split('\n\n');
        sseBuffer = eventChunks.pop() || '';

        for (var ci = 0; ci < eventChunks.length; ci++) {
          parseSSE(eventChunks[ci], function (evt) {
            log('SSE event:', evt.status, '| content length:', (evt.content || '').length);

            var msg = {
              messageId: evt.messageId || '',
              senderId: evt.senderId || botName,
              content: evt.content || '',
              contentType: evt.contentType || 'text/markdown',
              status: evt.status || 'incomplete',
              statusText: evt.statusText || undefined,
              attachments: evt.attachments || undefined
            };

            lastStatus = evt.status || lastStatus;

            handler({
              status: evt.status || 'incomplete',
              responses: [msg]
            }, handlerContext);
          });
        }
      }

      // If stream ended but we never got a "complete" event, flush remaining buffer and send complete
      if (sseBuffer.trim()) {
        parseSSE(sseBuffer, function (evt) {
          var msg = {
            messageId: evt.messageId || '',
            senderId: evt.senderId || botName,
            content: evt.content || '',
            contentType: evt.contentType || 'text/markdown',
            status: evt.status || 'complete',
            statusText: evt.statusText || undefined,
            attachments: evt.attachments || undefined
          };
          handler({
            status: evt.status || 'complete',
            responses: [msg]
          }, handlerContext);
          lastStatus = evt.status || 'complete';
        });
      }

      log('Stream finished, lastStatus:', lastStatus);
    }

    return { success: true };
  }

  // ---- getTriggerMessage stub ----
  async function getTriggerMessage() {
    return {
      messageId: '',
      senderId: '',
      content: '',
      contentType: 'text/plain',
      status: 'complete',
      attachments: []
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

  // ---- Expose API ----
  window.Poe = {
    sendUserMessage: sendUserMessage,
    registerHandler: registerHandler,
    getTriggerMessage: getTriggerMessage,
    captureCost: captureCost
  };

  log('Poe Adapter v2 initialized | proxy:', proxyUrl);
})();