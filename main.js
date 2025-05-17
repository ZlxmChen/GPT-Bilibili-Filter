// ==UserScript==
// @name         BiliFilter with OpenAI GPT-4o-mini comments
// @namespace    https://example.com/
// @version      1.0
// @description  Filtering Bilibili danmaku via OpenAI GPT-4o-mini
// @author       dddng
// @match        https://www.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.zetatechs.com
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  /**************** CONFIG ****************/
  const BACKEND_ENDPOINT = 'https://api.zetatechs.com/v1/chat/completions';
  const OPENAI_API_KEY = 'XXXXXXXXXX'; // 请将此处替换为您的实际 API 密钥
  const BATCH_SIZE = 20;
  const BATCH_TIMEOUT = 500; // ms
  const KEEP_CATEGORIES = new Set(['正常', '未分类']);
  const HIDE_CATEGORY = false;
  const MAX_CONCURRENT_REQUESTS = 4;
  const MAX_QUEUE_LENGTH = 0;

  const PROMPT_HEADER =
`请根据每条弹幕内容将其分类为以下10个类别之一：
正常、色情低俗、恶意刷屏、人身攻击、嘲讽、引战、脏话、同音脏话(与脏话读音相似)。

【格式要求】：
- 严格按照输入弹幕的顺序输出；
- 每一行只输出一个分类名称，不要添加编号、标点、解释或其它多余内容；
- 输出的行数必须等于输入弹幕数；
- 如果不确定，请填“未分类”；
视频标题：`;

  const CLASS_PAT = /^bili-danmaku-x-/;
  const log = (...a) => HIDE_CATEGORY && console.debug('[BiliFilter]', ...a);

  GM_addStyle(`.gpt-danmaku-hidden{${HIDE_CATEGORY ? 'visibility:hidden!important;' : ''}}`);

  const queue = [];
  const pendingBatches = [];
  let timer = null;
  let activeRequests = 0;

  /* utils */
  const cleanTitle = t => t.replace(/[-—]\s*bilibili.*$/i, '').trim();

  /* enqueue */
  function enqueue(node, text) {
    if (HIDE_CATEGORY) node.classList.add('gpt-danmaku-hidden');
    queue.push({ node, text });
    if (queue.length >= BATCH_SIZE) flushQueue();
    else if (!timer) timer = setTimeout(flushQueue, BATCH_TIMEOUT);
  }

  function maybeQueue(el) {
    if (!(el instanceof HTMLElement)) return;
    if (!CLASS_PAT.test(el.className)) return;
    const txt = el.textContent.trim();
    if (!txt) return;
    if (/\[[^\]]+\]$/.test(txt)) return;
    if (el.__dmfLast === txt) return;
    el.__dmfLast = txt;
    enqueue(el, txt);
  }

  /***************  network  ***************/
  function flushQueue() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    clearTimeout(timer); timer = null;

    pendingBatches.push(batch);
    maybeSendNext();
  }

  function discardBatch(batch) {
    log(`队列溢出，丢弃批次（${batch.length} 条）→ 未分类`);
    batch.forEach(item => {
      const category = '未分类';
      if (!HIDE_CATEGORY) {
        item.node.textContent = `${item.text} [${category}]`;
        item.node.__dmfLast = item.node.textContent;
        if (HIDE_CATEGORY) item.node.classList.remove('gpt-danmaku-hidden');
      } else {
        if (HIDE_CATEGORY) item.node.classList.remove('gpt-danmaku-hidden');
      }
    });
  }

  function checkQueueOverflow() {
    while (pendingBatches.length > MAX_QUEUE_LENGTH) {
      const old = pendingBatches.shift();
      discardBatch(old);
    }
  }

  function maybeSendNext() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && pendingBatches.length) {
      const batch = pendingBatches.shift();
      sendBatchRequest(batch);
    }
    checkQueueOverflow();
  }

  function sendBatchRequest(batch) {
    activeRequests++;

    const title = cleanTitle(document.querySelector('h1')?.innerText || document.title);
    const prompt = `${PROMPT_HEADER}${title}\n待分类弹幕：\n${batch.map(i => i.text).join('\n')}`;

    GM_xmlhttpRequest({
      method: 'POST',
      url: BACKEND_ENDPOINT,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      data: JSON.stringify({
        model: 'gemini-2.0-flash-lite',
        messages: [{ role: 'user', content: prompt }]
      }),
      onload: resp => {
        handleResponse(resp, batch);
        activeRequests--;
        maybeSendNext();
      },
      onerror: err => {
        console.error('[BiliFilter] request error', err);
        discardBatch(batch);
        activeRequests--;
        maybeSendNext();
      }
    });
  }

  function handleResponse(resp, batch) {
    let txt;
    try {
      const j = JSON.parse(resp.responseText || '{}');
      txt = j.choices?.[0]?.message?.content || '';
    } catch {
      txt = resp.responseText;
    }

    let lines = txt.trim().split(/\r?\n/);
    if (lines.length < batch.length)
      lines = lines.concat(Array(batch.length - lines.length).fill('未分类'));

    log('弹幕分类结果:\n' + lines.map((c, i) =>
      `${batch[i]?.text || '(missing)'} —> ${c}`).join('\n'));

    lines.forEach((cat, i) => {
      const item = batch[i]; if (!item) return;
      const category = cat.trim();
      if (!HIDE_CATEGORY) {
        item.node.textContent = `${item.text} [${category}]`;
        item.node.__dmfLast = item.node.textContent;
        if (HIDE_CATEGORY) item.node.classList.remove('gpt-danmaku-hidden');
      } else {
        if (!KEEP_CATEGORIES.has(category)) {
          item.node.style.display = 'none';
        } else if (HIDE_CATEGORY) {
          item.node.classList.remove('gpt-danmaku-hidden');
        }
      }
    });
  }

  /***************  observer  ***************/
  function attach(root) {
    const mo = new MutationObserver(ms => {
      ms.forEach(m => {
        if (m.type === 'childList') m.addedNodes.forEach(maybeQueue);
        if (m.type === 'characterData') maybeQueue(m.target.parentElement);
        if (m.type === 'attributes') maybeQueue(m.target);
        m.addedNodes.forEach(n => {
          if (n.shadowRoot) attach(n.shadowRoot);
          if (n.tagName === 'IFRAME') {
            try { const d = n.contentDocument; if (d) attach(d); } catch { }
          }
        });
      });
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    deepScan(root);
  }

  function deepScan(node) {
    maybeQueue(node);
    node.childNodes.forEach(c => { if (c instanceof HTMLElement) deepScan(c); });
    if (node.shadowRoot) attach(node.shadowRoot);
    if (node.tagName === 'IFRAME') {
      try { const d = node.contentDocument; if (d) attach(d); } catch { }
    }
  }

  attach(document);

  setInterval(() => {
    document.querySelectorAll('*').forEach(el => {
      if (CLASS_PAT.test(el.className)) maybeQueue(el);
      if (el.shadowRoot) el.shadowRoot.querySelectorAll('*').forEach(maybeQueue);
    });
  }, 1000);

  unsafeWindow.dmfAddDanmaku = (txt = '调试弹幕') => {
    const d = document.createElement('div');
    d.className = 'bili-danmaku-x-dm';
    d.textContent = txt;
    document.body.appendChild(d);
  };
  unsafeWindow.dmfFlush = () => flushQueue();
})();