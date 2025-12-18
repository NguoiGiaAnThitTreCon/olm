// ==UserScript==
// @name         OLM Ultimate Viewer - Fix Missing Answers
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Xem đáp án OLM (Fix lỗi không hiện đáp án + UI Glassmorphism)
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
    // 1. CORE UTILITIES (LOGIC TÌM ĐÁP ÁN MẠNH MẼ HƠN)
    // ==========================================
    const Utils = {
        decodeBase64: (str) => {
            try {
                return new TextDecoder('utf-8').decode(
                    Uint8Array.from(atob(str), c => c.charCodeAt(0))
                );
            } catch (e) { return null; }
        },

        cleanHTML: (html, fallbackTitle) => {
            const div = document.createElement('div');
            div.innerHTML = html;
            // Xóa các phần tử rác không cần thiết
            const trash = ['.loigiai', '.solution', '.answer-section', 'script', 'style', '.interaction', '.explanation'];
            trash.forEach(s => div.querySelectorAll(s).forEach(e => e.remove()));

            let content = div.innerHTML.trim();
            // Nếu nội dung quá ngắn hoặc rỗng, dùng title
            return (content.length > 5) ? content : (fallbackTitle || 'Câu hỏi hình ảnh/âm thanh');
        },

        // --- HÀM TÌM ĐÁP ÁN ĐƯỢC NÂNG CẤP ---
        getAnswers: (html, json) => {
            let results = new Set(); // Dùng Set để tự động loại bỏ trùng lặp

            // 1. QUÉT JSON (Độ chính xác 100%)
            if (json) {
                try {
                    const data = JSON.parse(json);

                    // Hàm đệ quy tìm tất cả node có thuộc tính correct = true
                    const deepScan = (obj) => {
                        if (!obj || typeof obj !== 'object') return;

                        // Nếu tìm thấy dấu hiệu đúng
                        if (obj.correct === true || obj.is_correct === true || obj.score > 0) {
                            if (obj.text) results.add(Utils.stripTags(obj.text));
                            if (obj.content) results.add(Utils.stripTags(obj.content));
                        }

                        // Duyệt qua các con (children, options, pairs...)
                        Object.keys(obj).forEach(key => {
                            if (typeof obj[key] === 'object') deepScan(obj[key]);
                        });
                    };
                    deepScan(data);
                } catch(e){}
            }

            // 2. QUÉT HTML (Fallback nếu JSON không có hoặc thiếu)
            const div = document.createElement('div');
            div.innerHTML = html;

            // Danh sách các class/selector OLM thường dùng cho đáp án đúng
            const selectors = [
                '.correctAnswer',
                '[data-correct="true"]',
                '.correct',
                '.answer-correct',
                '.option.correct',
                '.item-choice.correct',
                'input[checked]',
                'input[type="radio"][value="true"]',
                '.true-answer'
            ];

            selectors.forEach(sel => {
                div.querySelectorAll(sel).forEach(el => {
                    // Lấy text của chính nó hoặc label đi kèm
                    let txt = el.textContent.trim();

                    // Nếu là input radio/checkbox, tìm label label liên quan
                    if (el.tagName === 'INPUT') {
                        const id = el.id;
                        if (id) {
                            const label = div.querySelector(`label[for="${id}"]`);
                            if (label) txt = label.textContent.trim();
                        } else if (el.parentElement) {
                            txt = el.parentElement.textContent.trim();
                        }
                    }

                    if(txt) results.add(txt);
                });
            });

            // 3. XỬ LÝ DẠNG ĐIỀN TỪ (Fill in blank)
            div.querySelectorAll('input[data-accept]').forEach(i => {
                const accepts = i.dataset.accept.split('|');
                accepts.forEach(val => results.add(val.trim()));
            });

            // 4. REGEX SCAN (Biện pháp cuối cùng - Quét text thô)
            // Tìm các đoạn text nằm cạnh attribute correct="true" trong chuỗi HTML
            if (results.size === 0) {
                const regex = /<[^>]*correct="true"[^>]*>([^<]+)</g;
                let match;
                while ((match = regex.exec(html)) !== null) {
                    if (match[1]) results.add(match[1].trim());
                }
            }

            return Array.from(results);
        },

        stripTags: (html) => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.body.textContent || "";
        },

        getSolution: (html) => {
            const div = document.createElement('div');
            div.innerHTML = html;
            // Tìm các class chứa lời giải
            const sol = div.querySelector('.loigiai, .solution, .huong-dan-giai, .explanation, .exp, .giai-chi-tiet');
            if (!sol) return null;

            // Xóa tiêu đề thừa
            sol.querySelectorAll('strong, h2, h3, h4, .title').forEach(el => {
                const txt = el.textContent.toLowerCase();
                if(txt.includes('lời giải') || txt.includes('hướng dẫn') || txt.includes('giải thích')) el.remove();
            });
            return sol.innerHTML.trim();
        }
    };

    // ==========================================
    // 2. UI CLASS (GIAO DIỆN GLASSMORPHISM)
    // ==========================================
    class ViewerUI {
        constructor() {
            this.state = {
                data: [],
                visible: true,
                minimized: false,
                search: '',
                pos: { x: 20, y: 20 }
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
                @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap');

                :root {
                    --olm-bg: rgba(15, 23, 42, 0.9);
                    --olm-border: rgba(255, 255, 255, 0.15);
                    --olm-accent: #8b5cf6;
                    --olm-success: #10b981;
                    --olm-text: #f1f5f9;
                }

                .uv-container {
                    position: fixed; width: 450px; max-height: 85vh;
                    background: var(--olm-bg);
                    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                    border: 1px solid var(--olm-border);
                    border-radius: 16px;
                    box-shadow: 0 20px 50px rgba(0,0,0,0.6);
                    color: var(--olm-text);
                    font-family: 'Be Vietnam Pro', sans-serif;
                    z-index: 999999;
                    display: flex; flex-direction: column;
                    transition: all 0.3s ease;
                }

                .uv-container.minimized { height: 60px !important; overflow: hidden; }
                .uv-container.hidden { opacity: 0; pointer-events: none; transform: translateY(20px) scale(0.95); }

                /* HEADER */
                .uv-header {
                    padding: 16px;
                    background: linear-gradient(to right, rgba(255,255,255,0.05), transparent);
                    border-bottom: 1px solid var(--olm-border);
                    display: flex; justify-content: space-between; align-items: center;
                    cursor: grab; user-select: none;
                }
                .uv-header:active { cursor: grabbing; }

                .uv-brand { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; }
                .uv-pulse { width: 8px; height: 8px; background: var(--olm-success); border-radius: 50%; box-shadow: 0 0 12px var(--olm-success); animation: pulse 2s infinite; }
                @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }

                .uv-badge { background: var(--olm-accent); padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }

                .uv-ctrls { display: flex; gap: 8px; }
                .uv-btn {
                    width: 30px; height: 30px; border-radius: 8px; border: none;
                    background: rgba(255,255,255,0.08); color: #cbd5e1;
                    cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; font-size: 16px;
                }
                .uv-btn:hover { background: rgba(255,255,255,0.2); color: #fff; transform: scale(1.05); }
                .uv-btn.close:hover { background: #ef4444; }

                /* TOOLBAR */
                .uv-toolbar { padding: 12px; display: flex; gap: 10px; border-bottom: 1px solid var(--olm-border); }
                .uv-search {
                    flex: 1; background: rgba(0,0,0,0.4); border: 1px solid var(--olm-border);
                    padding: 10px 14px; border-radius: 10px; color: #fff; outline: none; font-size: 13px;
                    transition: border 0.2s;
                }
                .uv-search:focus { border-color: var(--olm-accent); }

                /* CONTENT */
                .uv-content { flex: 1; overflow-y: auto; padding: 14px; scroll-behavior: smooth; }
                .uv-content::-webkit-scrollbar { width: 6px; }
                .uv-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
                .uv-content::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

                .uv-card {
                    background: rgba(255,255,255,0.02); border: 1px solid var(--olm-border);
                    border-radius: 12px; padding: 16px; margin-bottom: 14px;
                    transition: all 0.2s; position: relative; overflow: hidden;
                }
                .uv-card:hover { transform: translateY(-2px); border-color: rgba(139, 92, 246, 0.5); background: rgba(255,255,255,0.04); }

                .uv-q-head { display: flex; gap: 12px; margin-bottom: 12px; }
                .uv-idx {
                    background: linear-gradient(135deg, var(--olm-accent), #6366f1);
                    width: 28px; height: 28px; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    border-radius: 8px; font-weight: 700; font-size: 13px; box-shadow: 0 4px 10px rgba(139, 92, 246, 0.3);
                }
                .uv-q-txt { font-size: 14px; line-height: 1.6; color: #e2e8f0; word-wrap: break-word; }
                .uv-q-txt img { max-width: 100%; border-radius: 6px; margin-top: 8px; border: 1px solid var(--olm-border); }

                .uv-box { padding: 12px; border-radius: 10px; margin-top: 10px; font-size: 14px; }
                .uv-ans { background: rgba(16, 185, 129, 0.1); border-left: 4px solid var(--olm-success); }
                .uv-sol { background: rgba(59, 130, 246, 0.1); border-left: 4px solid #3b82f6; }

                .uv-label { font-size: 11px; font-weight: 800; text-transform: uppercase; margin-bottom: 6px; opacity: 0.9; letter-spacing: 0.5px; }
                .uv-ans .uv-label { color: var(--olm-success); }
                .uv-sol .uv-label { color: #60a5fa; }

                .uv-list { margin: 0; padding-left: 18px; color: #f8fafc; font-weight: 500; }
                .uv-list li { margin-bottom: 4px; }

                /* FLOATING BTN */
                .uv-float {
                    position: fixed; bottom: 30px; right: 30px;
                    width: 56px; height: 56px; border-radius: 50%;
                    background: linear-gradient(135deg, #8b5cf6, #ec4899);
                    box-shadow: 0 4px 25px rgba(139, 92, 246, 0.6);
                    border: 2px solid rgba(255,255,255,0.2);
                    color: #fff; font-size: 26px; cursor: pointer;
                    z-index: 999998; transition: 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    display: flex; align-items: center; justify-content: center;
                }
                .uv-float:hover { transform: scale(1.15) rotate(15deg); box-shadow: 0 6px 35px rgba(139, 92, 246, 0.8); }
                .uv-float.hide { display: none; }

                /* MATHJAX OVERRIDE */
                mjx-container { font-size: 115% !important; color: #fff !important; }
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }

        renderContainer() {
            this.root = document.createElement('div');
            this.root.className = 'uv-container';
            this.root.style.left = this.state.pos.x + 'px';
            this.root.style.top = this.state.pos.y + 'px';

            this.root.innerHTML = `
                <div class="uv-header">
                    <div class="uv-brand">
                        <div class="uv-pulse"></div>
                        <span>OLM ULTIMATE</span>
                        <span class="uv-badge">0</span>
                    </div>
                    <div class="uv-ctrls">
                        <button class="uv-btn min" title="Thu gọn">─</button>
                        <button class="uv-btn close" title="Ẩn">✕</button>
                    </div>
                </div>
                <div class="uv-toolbar">
                    <input type="text" class="uv-search" placeholder="Tìm kiếm câu hỏi (beta)...">
                    <button class="uv-btn clear" title="Xóa dữ liệu cũ">🗑️</button>
                </div>
                <div class="uv-content">
                    <div style="text-align:center; padding: 60px 20px; opacity: 0.5;">
                        <div style="font-size: 42px; margin-bottom: 16px; animation: float 3s ease-in-out infinite;">🛸</div>
                        <div style="font-weight:600; font-size:15px;">Đang quét dữ liệu...</div>
                        <div style="font-size:12px; margin-top:6px;">Hãy vào bài làm để kích hoạt</div>
                    </div>
                </div>
            `;

            this.floatBtn = document.createElement('button');
            this.floatBtn.className = 'uv-float hide';
            this.floatBtn.innerHTML = '⚡';

            document.body.appendChild(this.root);
            document.body.appendChild(this.floatBtn);

            // Cache DOM
            this.dom = {
                content: this.root.querySelector('.uv-content'),
                badge: this.root.querySelector('.uv-badge'),
                search: this.root.querySelector('.uv-search')
            };
        }

        bindEvents() {
            // Drag Logic
            const header = this.root.querySelector('.uv-header');
            let isDragging = false, offset = {x:0, y:0};

            header.addEventListener('mousedown', (e) => {
                if(e.target.tagName === 'BUTTON') return;
                isDragging = true;
                const rect = this.root.getBoundingClientRect();
                offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                this.root.style.transition = 'none'; // Disable transition when dragging
            });

            document.addEventListener('mousemove', (e) => {
                if(!isDragging) return;
                e.preventDefault();
                this.root.style.left = (e.clientX - offset.x) + 'px';
                this.root.style.top = (e.clientY - offset.y) + 'px';
            });

            document.addEventListener('mouseup', () => {
                if(isDragging) {
                    isDragging = false;
                    this.root.style.transition = 'all 0.3s ease';
                }
            });

            // Actions
            this.root.querySelector('.min').onclick = () => {
                this.state.minimized = !this.state.minimized;
                this.root.classList.toggle('minimized', this.state.minimized);
                this.root.querySelector('.min').textContent = this.state.minimized ? '◻' : '─';
            };

            const toggle = () => {
                this.state.visible = !this.state.visible;
                this.root.classList.toggle('hidden', !this.state.visible);
                this.floatBtn.classList.toggle('hide', this.state.visible);
            };
            this.root.querySelector('.close').onclick = toggle;
            this.floatBtn.onclick = toggle;

            this.root.querySelector('.clear').onclick = () => {
                if(confirm('Bạn muốn xóa danh sách hiện tại?')) {
                    this.state.data = [];
                    this.renderList();
                }
            };

            this.dom.search.addEventListener('input', (e) => {
                this.state.search = e.target.value.toLowerCase();
                this.renderList();
            });

            // Shortcut Shift Right
            document.addEventListener('keydown', (e) => {
                if(e.code === 'ShiftRight') toggle();
            });
        }

        addData(rawData) {
            if (!Array.isArray(rawData)) return;

            let hasNew = false;
            rawData.forEach((item, idx) => {
                const decoded = Utils.decodeBase64(item.content || '');
                if (!decoded) return;

                const qObj = {
                    id: item.id || (Date.now() + idx),
                    html: Utils.cleanHTML(decoded, item.title),
                    answers: Utils.getAnswers(decoded, item.json_content),
                    solution: Utils.getSolution(decoded)
                };

                // Push vào cuối để giữ thứ tự 1, 2, 3
                if (!this.state.data.find(x => x.id === qObj.id)) {
                    this.state.data.push(qObj);
                    hasNew = true;
                }
            });

            if (hasNew) this.renderList();
        }

        renderList() {
            const { data, search } = this.state;
            const filtered = data.filter(item => {
                const temp = document.createElement('div');
                temp.innerHTML = item.html;
                return !search || temp.textContent.toLowerCase().includes(search);
            });

            this.dom.badge.textContent = data.length;

            if (filtered.length === 0) {
                if (data.length > 0) {
                    this.dom.content.innerHTML = `<div style="text-align:center; padding: 20px; opacity:0.6">Không tìm thấy kết quả</div>`;
                }
                return;
            }

            this.dom.content.innerHTML = filtered.map((item, index) => {
                let ansHTML = '';
                if (item.answers.length > 0) {
                    ansHTML = `
                        <div class="uv-box uv-ans">
                            <div class="uv-label">✓ ĐÁP ÁN</div>
                            <ul class="uv-list">
                                ${item.answers.map(a => `<li>${a}</li>`).join('')}
                            </ul>
                        </div>`;
                }

                let solHTML = '';
                if (item.solution) {
                    solHTML = `
                        <div class="uv-box uv-sol">
                            <div class="uv-label">✎ LỜI GIẢI CHI TIẾT</div>
                            <div style="line-height:1.5">${item.solution}</div>
                        </div>`;
                }

                // Nếu không có cả đáp án và lời giải -> Cảnh báo
                let emptyHTML = '';
                if (!ansHTML && !solHTML) {
                    emptyHTML = `<div class="uv-box" style="background:rgba(255,255,255,0.05); border:1px dashed rgba(255,255,255,0.2); font-style:italic; opacity:0.7">⚠️ Chưa quét được đáp án cho câu này</div>`;
                }

                return `
                    <div class="uv-card">
                        <div class="uv-q-head">
                            <div class="uv-idx">${index + 1}</div>
                            <div class="uv-q-txt">${item.html}</div>
                        </div>
                        ${ansHTML}
                        ${solHTML}
                        ${emptyHTML}
                    </div>
                `;
            }).join('');

            this.renderMath();
        }

        renderMath() {
            setTimeout(() => {
                const w = unsafeWindow || window;
                if (w.MathJax) {
                    if(w.MathJax.typesetPromise) w.MathJax.typesetPromise([this.dom.content]).catch(()=>{});
                    else if(w.MathJax.Hub) w.MathJax.Hub.Queue(["Typeset", w.MathJax.Hub, this.dom.content]);
                }
                // Hỗ trợ Katex nếu có
                if (w.renderKatex) { /* logic katex */ }
            }, 100);
        }
    }

    // ==========================================
    // 3. MAIN (KHỞI CHẠY)
    // ==========================================
    const Main = () => {
        console.log('🚀 OLM Ultimate Viewer v5.1 (Fix) Started');
        const app = new ViewerUI();
        const w = unsafeWindow || window;

        // --- XHR Hook ---
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

        // --- Fetch Hook ---
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

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Main);
    else Main();

})();
