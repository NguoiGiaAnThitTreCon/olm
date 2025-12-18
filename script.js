// ==UserScript==
// @name         OLM Answer Viewer - Minimalist (Only Answers)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Chỉ hiện đáp án theo thứ tự câu hỏi (Giao diện gọn gàng)
// @author       NguyenTrongg
// @match        https://olm.vn/*
// @match        https://*.olm.vn/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      olm.vn
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. UTILITIES (XỬ LÝ DỮ LIỆU)
    // ==========================================
    const Utils = {
        decodeBase64: (str) => {
            try {
                return new TextDecoder('utf-8').decode(
                    Uint8Array.from(atob(str), c => c.charCodeAt(0))
                );
            } catch (e) { return null; }
        },

        // Logic tìm đáp án thông minh (Deep Scan)
        getAnswers: (html, json) => {
            let results = new Set();

            // 1. Quét JSON
            if (json) {
                try {
                    const data = JSON.parse(json);
                    const deepScan = (obj) => {
                        if (!obj || typeof obj !== 'object') return;
                        if (obj.correct === true || obj.is_correct === true || obj.score > 0) {
                            if (obj.text) results.add(Utils.stripTags(obj.text));
                            if (obj.content) results.add(Utils.stripTags(obj.content));
                        }
                        Object.keys(obj).forEach(key => {
                            if (typeof obj[key] === 'object') deepScan(obj[key]);
                        });
                    };
                    deepScan(data);
                } catch(e){}
            }

            // 2. Quét HTML
            const div = document.createElement('div');
            div.innerHTML = html;
            const selectors = ['.correctAnswer', '[data-correct="true"]', '.correct', '.answer-correct', 'input[checked]', '.true-answer'];
            selectors.forEach(sel => {
                div.querySelectorAll(sel).forEach(el => {
                    let txt = el.textContent.trim();
                    if (el.tagName === 'INPUT' && el.parentElement) txt = el.parentElement.textContent.trim();
                    if(txt) results.add(txt);
                });
            });

            // 3. Quét điền từ
            div.querySelectorAll('input[data-accept]').forEach(i => {
                i.dataset.accept.split('|').forEach(val => results.add(val.trim()));
            });

            return Array.from(results);
        },

        getSolution: (html) => {
            const div = document.createElement('div');
            div.innerHTML = html;
            const sol = div.querySelector('.loigiai, .solution, .huong-dan-giai, .explanation, .giai-chi-tiet');
            if (!sol) return null;
            sol.querySelectorAll('strong, h2, h3, .title').forEach(el => el.remove());
            return sol.innerHTML.trim();
        },

        stripTags: (html) => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.body.textContent || "";
        }
    };

    // ==========================================
    // 2. UI CLASS (GIAO DIỆN COMPACT)
    // ==========================================
    class ViewerUI {
        constructor() {
            this.state = {
                data: [],
                visible: true,
                minimized: false,
                pos: { x: 20, y: 80 }
            };
            this.init();
        }

        init() {
            this.addStyles();
            this.renderContainer();
            this.bindEvents();
        }

        addStyles() {
            const css = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');

                :root {
                    --bg-glass: rgba(20, 20, 25, 0.95);
                    --border: rgba(255, 255, 255, 0.1);
                    --accent: #6366f1; /* Indigo */
                    --success: #10b981; /* Emerald */
                    --text: #f8fafc;
                }

                .olm-min-container {
                    position: fixed; width: 320px; max-height: 80vh;
                    background: var(--bg-glass);
                    backdrop-filter: blur(12px);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    font-family: 'Inter', sans-serif;
                    z-index: 999999;
                    display: flex; flex-direction: column;
                    color: var(--text);
                    transition: height 0.3s, opacity 0.3s;
                }
                .olm-min-container.min { height: 50px !important; overflow: hidden; }
                .olm-min-container.hidden { opacity: 0; pointer-events: none; }

                /* Header */
                .olm-header {
                    padding: 12px 16px;
                    background: rgba(255,255,255,0.05);
                    border-bottom: 1px solid var(--border);
                    display: flex; justify-content: space-between; align-items: center;
                    cursor: grab;
                }
                .olm-title { font-weight: 800; font-size: 13px; letter-spacing: 0.5px; color: var(--accent); }
                .olm-badge { background: #333; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 8px; color: #fff; }

                .olm-ctrls button {
                    background: transparent; border: none; color: #94a3b8;
                    cursor: pointer; font-size: 16px; padding: 0 4px;
                }
                .olm-ctrls button:hover { color: #fff; }

                /* Content List */
                .olm-content { flex: 1; overflow-y: auto; padding: 10px; }
                .olm-content::-webkit-scrollbar { width: 4px; }
                .olm-content::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

                /* Cards */
                .olm-card {
                    background: rgba(255,255,255,0.03);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 10px;
                    margin-bottom: 8px;
                    position: relative;
                }
                .olm-card:hover { border-color: var(--accent); background: rgba(255,255,255,0.05); }

                .olm-card-head {
                    display: flex; align-items: center; justify-content: space-between;
                    margin-bottom: 6px;
                }
                .olm-q-num {
                    font-size: 11px; font-weight: 800; text-transform: uppercase;
                    color: #94a3b8;
                }
                .olm-q-num span { color: var(--text); font-size: 13px; }

                .olm-ans-box {
                    font-size: 13px; font-weight: 600; color: var(--success);
                    line-height: 1.4;
                    padding: 6px 10px;
                    background: rgba(16, 185, 129, 0.1);
                    border-radius: 6px;
                    border-left: 3px solid var(--success);
                }

                .olm-sol-toggle {
                    margin-top: 6px; font-size: 10px; color: #60a5fa;
                    cursor: pointer; text-decoration: underline; opacity: 0.8;
                }
                .olm-sol-content {
                    margin-top: 6px; padding: 8px; background: rgba(59, 130, 246, 0.1);
                    border-radius: 6px; font-size: 12px; display: none; color: #cbd5e1;
                }
                .olm-sol-content.show { display: block; }

                .olm-empty { font-size: 11px; font-style: italic; color: #64748b; }

                /* Float Btn */
                .olm-float {
                    position: fixed; bottom: 20px; right: 20px;
                    width: 40px; height: 40px; border-radius: 50%;
                    background: var(--accent); color: white; border: none;
                    box-shadow: 0 4px 15px rgba(99, 102, 241, 0.5);
                    cursor: pointer; display: flex; align-items: center; justify-content: center;
                    font-size: 20px; z-index: 999998;
                }
                .olm-float.hidden { display: none; }

                mjx-container { font-size: 105% !important; color: inherit !important; }
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }

        renderContainer() {
            this.root = document.createElement('div');
            this.root.className = 'olm-min-container';
            this.root.style.left = this.state.pos.x + 'px';
            this.root.style.top = this.state.pos.y + 'px';

            this.root.innerHTML = `
                <div class="olm-header">
                    <div style="display:flex; align-items:center">
                        <span class="olm-title">ANSWER KEY</span>
                        <span class="olm-badge">0</span>
                    </div>
                    <div class="olm-ctrls">
                        <button class="min" title="Thu gọn">_</button>
                        <button class="close" title="Ẩn">×</button>
                    </div>
                </div>
                <div class="olm-content">
                    <div style="text-align:center; padding: 30px 10px; color:#64748b; font-size:12px;">
                        Chờ tải câu hỏi...
                    </div>
                </div>
            `;

            this.floatBtn = document.createElement('button');
            this.floatBtn.className = 'olm-float hidden';
            this.floatBtn.innerHTML = '🔑';

            document.body.appendChild(this.root);
            document.body.appendChild(this.floatBtn);

            // Refs
            this.contentRef = this.root.querySelector('.olm-content');
            this.badgeRef = this.root.querySelector('.olm-badge');
        }

        bindEvents() {
            // Drag
            const header = this.root.querySelector('.olm-header');
            let isDragging = false, offset = {x:0, y:0};
            header.addEventListener('mousedown', (e) => {
                if(e.target.tagName==='BUTTON') return;
                isDragging = true;
                const r = this.root.getBoundingClientRect();
                offset = {x: e.clientX - r.left, y: e.clientY - r.top};
            });
            document.addEventListener('mousemove', (e) => {
                if(!isDragging) return;
                this.root.style.left = (e.clientX - offset.x) + 'px';
                this.root.style.top = (e.clientY - offset.y) + 'px';
            });
            document.addEventListener('mouseup', () => isDragging = false);

            // Controls
            this.root.querySelector('.min').onclick = () => {
                this.state.minimized = !this.state.minimized;
                this.root.classList.toggle('min', this.state.minimized);
            };
            const toggle = () => {
                this.state.visible = !this.state.visible;
                this.root.classList.toggle('hidden', !this.state.visible);
                this.floatBtn.classList.toggle('hidden', this.state.visible);
            };
            this.root.querySelector('.close').onclick = toggle;
            this.floatBtn.onclick = toggle;
            document.addEventListener('keydown', (e) => { if(e.code==='ShiftRight') toggle(); });
        }

        addData(rawData) {
            if (!Array.isArray(rawData)) return;
            let hasNew = false;

            rawData.forEach((item, idx) => {
                const decoded = Utils.decodeBase64(item.content || '');
                if (!decoded) return;

                // ID tạm: dùng timestamp + index để đảm bảo duy nhất
                const id = item.id || (Date.now() + idx);

                if (!this.state.data.find(x => x.id === id)) {
                    this.state.data.push({
                        id: id,
                        answers: Utils.getAnswers(decoded, item.json_content),
                        solution: Utils.getSolution(decoded)
                    });
                    hasNew = true;
                }
            });

            if (hasNew) this.renderList();
        }

        renderList() {
            this.badgeRef.textContent = this.state.data.length;

            if (this.state.data.length === 0) return;

            this.contentRef.innerHTML = this.state.data.map((item, index) => {
                // Xử lý hiển thị đáp án
                let ansHTML = '<div class="olm-empty">Chưa có đáp án</div>';
                if (item.answers.length > 0) {
                    ansHTML = `
                        <div class="olm-ans-box">
                            ${item.answers.map(a => `<div>• ${a}</div>`).join('')}
                        </div>`;
                }

                // Xử lý hiển thị lời giải (ẩn mặc định)
                let solHTML = '';
                if (item.solution) {
                    const uniqueId = `sol-${index}`;
                    solHTML = `
                        <div class="olm-sol-toggle" onclick="document.getElementById('${uniqueId}').classList.toggle('show')">
                            Xem lời giải chi tiết ▼
                        </div>
                        <div id="${uniqueId}" class="olm-sol-content">
                            ${item.solution}
                        </div>
                    `;
                }

                return `
                    <div class="olm-card">
                        <div class="olm-card-head">
                            <div class="olm-q-num">CÂU <span>${index + 1}</span></div>
                        </div>
                        ${ansHTML}
                        ${solHTML}
                    </div>
                `;
            }).join('');

            this.renderMath();
        }

        renderMath() {
            setTimeout(() => {
                const w = unsafeWindow || window;
                if (w.MathJax) {
                    if (w.MathJax.typesetPromise) w.MathJax.typesetPromise([this.contentRef]).catch(()=>{});
                    else if (w.MathJax.Hub) w.MathJax.Hub.Queue(["Typeset", w.MathJax.Hub, this.contentRef]);
                }
            }, 200);
        }
    }

    // ==========================================
    // 3. INIT & HOOKS
    // ==========================================
    const Main = () => {
        console.log('OLM Minimalist Viewer Started');
        const app = new ViewerUI();
        const w = unsafeWindow || window;

        // Hook XHR
        const origOpen = w.XMLHttpRequest.prototype.open;
        w.XMLHttpRequest.prototype.open = function(method, url) {
            this.addEventListener('load', function() {
                if (url && (url.includes('get-question') || url.includes('/question'))) {
                    try {
                        const json = JSON.parse(this.responseText);
                        const list = Array.isArray(json) ? json : (json.data || json.questions || json.result);
                        if (list) app.addData(list);
                    } catch(e){}
                }
            });
            origOpen.apply(this, arguments);
        };

        // Hook Fetch
        const origFetch = w.fetch;
        w.fetch = async (...args) => {
            const response = await origFetch(...args);
            const url = args[0] instanceof Request ? args[0].url : args[0];
            if (url && (url.includes('get-question') || url.includes('/question'))) {
                response.clone().json().then(json => {
                    const list = Array.isArray(json) ? json : (json.data || json.questions || json.result);
                    if (list) app.addData(list);
                }).catch(()=>{});
            }
            return response;
        };
    };

    Main();
})();
