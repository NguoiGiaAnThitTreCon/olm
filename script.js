// ==UserScript==
// @name         OLM Answer Viewer - Deep Space Edition
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Xem đáp án OLM tự động (Fix MathJax & UI Upgrade)
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

    // ============ UTILITY FUNCTIONS ============
    const decodeBase64Utf8 = (base64) => {
        try {
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            return null; // Silent fail
        }
    };

    const extractAnswerFromJSON = (jsonContent) => {
        try {
            const jsonData = JSON.parse(jsonContent);
            const answers = [];
            const findAllCorrect = (node) => {
                if (!node) return;
                if (node.correct === true) {
                    const text = extractText(node);
                    if (text) answers.push(text);
                }
                if (node.children) node.children.forEach(child => findAllCorrect(child));
            };
            const extractText = (node) => {
                if (!node) return '';
                let text = node.text || '';
                if (node.children) text += node.children.map(extractText).join('');
                return text.trim();
            };
            findAllCorrect(jsonData.root);
            return answers.length > 0 ? answers : null;
        } catch (e) {
            return null;
        }
    };

    const extractAnswerFromHTML = (html) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const answers = [];
        const selectors = [
            '.correctAnswer', '.correct-answer', '[data-correct="true"]',
            '.answer.correct', 'input[type="radio"][checked]', 'input[type="checkbox"][checked]',
            '.selected.correct', 'li.correct', 'div.correct', 'span.correct'
        ];

        selectors.forEach(selector => {
            tempDiv.querySelectorAll(selector).forEach(el => {
                const text = el.textContent.trim();
                if (text && !answers.includes(text)) answers.push(text);
            });
        });

        tempDiv.querySelectorAll('input[data-accept]').forEach(input => {
            input.getAttribute('data-accept').split('|').forEach(val => {
                const text = val.trim();
                if (text && !answers.includes(text)) answers.push(text);
            });
        });

        tempDiv.querySelectorAll('[data-answer], [answer]').forEach(el => {
            const answer = el.getAttribute('data-answer') || el.getAttribute('answer');
            if (answer && !answers.includes(answer.trim())) answers.push(answer.trim());
        });

        return answers.length > 0 ? answers : null;
    };

    const extractSolution = (html) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const selectors = ['.loigiai', '.huong-dan-giai', '.explain', '.explanation', '.solution', '#solution', '.guide', '.giai-chi-tiet'];

        for (const selector of selectors) {
            const element = tempDiv.querySelector(selector);
            if (element) {
                // Xóa tiêu đề thừa (Lời giải: ...)
                element.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b').forEach(h => {
                    if (h.textContent.trim().match(/^(lời giải|hướng dẫn|giải|solution|explain)/i)) {
                        h.remove();
                    }
                });
                const content = element.innerHTML.trim();
                if (content) return content; // Return innerHTML string
            }
        }
        return null;
    };

    const extractCleanQuestion = (html, title) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const removeSelectors = [
            'ol.quiz-list', 'ul.quiz-list', '.interaction', '.form-group',
            '.loigiai', '.huong-dan-giai', '.explain', '.solution',
            '.answer-section', '.correctAnswer', 'script', 'style'
        ];
        removeSelectors.forEach(s => tempDiv.querySelectorAll(s).forEach(el => el.remove()));
        let content = tempDiv.innerHTML.trim();
        return (!content || content.length < 5) ? (title || 'Câu hỏi') : content;
    };

    // ============ UI CLASS ============
    class AnswerViewerUI {
        constructor() {
            this.answers = [];
            this.isVisible = true;
            this.isMinimized = false;
            this.searchTerm = '';
            this.position = { x: 20, y: 80 };
            this.isDragging = false;
            this.dragOffset = { x: 0, y: 0 };
            this.init();
        }

        init() {
            this.injectStyles();
            this.createUI();
            this.attachEvents();
        }

        injectStyles() {
            const styles = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

                @keyframes slideIn { from { transform: translateX(-20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
                @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.4); } 70% { box-shadow: 0 0 0 10px rgba(124, 58, 237, 0); } 100% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); } }
                @keyframes stars { from { background-position: 0 0; } to { background-position: 1000px 1000px; } }

                .olm-viewer-container {
                    position: fixed !important;
                    width: 450px;
                    max-height: 85vh;
                    background: rgba(10, 10, 15, 0.95);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
                    z-index: 999999 !important;
                    display: flex;
                    flex-direction: column;
                    font-family: 'Inter', system-ui, sans-serif;
                    animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                    color: #e2e8f0;
                    overflow: hidden;
                    transition: height 0.3s ease, opacity 0.3s ease;
                }

                /* Background Stars Effect */
                .olm-viewer-container::before {
                    content: "";
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-image:
                        radial-gradient(white, rgba(255,255,255,.2) 2px, transparent 3px),
                        radial-gradient(white, rgba(255,255,255,.15) 1px, transparent 2px),
                        radial-gradient(white, rgba(255,255,255,.1) 2px, transparent 3px);
                    background-size: 550px 550px, 350px 350px, 250px 250px;
                    background-position: 0 0, 40px 60px, 130px 270px;
                    opacity: 0.3;
                    pointer-events: none;
                    z-index: 0;
                }

                .olm-viewer-container.minimized { max-height: 60px; overflow: hidden; }
                .olm-viewer-container.hidden { opacity: 0; pointer-events: none; transform: scale(0.95); }

                .olm-header {
                    padding: 16px;
                    background: rgba(255, 255, 255, 0.03);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    cursor: grab;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    position: relative;
                    z-index: 2;
                }
                .olm-header:active { cursor: grabbing; }

                .olm-title-group { display: flex; align-items: center; gap: 10px; }
                .olm-status-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981; }
                .olm-title { font-weight: 700; font-size: 15px; background: linear-gradient(90deg, #fff, #a5b4fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
                .olm-badge { background: #4f46e5; color: white; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; box-shadow: 0 0 10px rgba(79, 70, 229, 0.4); }

                .olm-controls { display: flex; gap: 8px; }
                .olm-btn-icon {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    color: #94a3b8;
                    width: 28px; height: 28px;
                    border-radius: 6px;
                    cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 14px;
                    transition: all 0.2s;
                }
                .olm-btn-icon:hover { background: rgba(255, 255, 255, 0.1); color: white; border-color: rgba(255,255,255,0.2); }
                .olm-btn-close:hover { background: #ef4444; border-color: #ef4444; }

                .olm-toolbar {
                    padding: 12px;
                    background: rgba(0, 0, 0, 0.2);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                    display: flex; gap: 8px; position: relative; z-index: 2;
                }

                .olm-search-wrapper { position: relative; flex: 1; }
                .olm-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #64748b; font-size: 12px; }
                .olm-search {
                    width: 100%;
                    padding: 8px 10px 8px 30px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                    color: white; font-size: 13px; outline: none; box-sizing: border-box;
                    transition: border-color 0.2s;
                }
                .olm-search:focus { border-color: #6366f1; }

                .olm-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 12px;
                    position: relative; z-index: 2;
                }
                .olm-content::-webkit-scrollbar { width: 6px; }
                .olm-content::-webkit-scrollbar-track { background: transparent; }
                .olm-content::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }
                .olm-content::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.25); }

                .olm-card {
                    background: rgba(30, 41, 59, 0.4);
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 12px;
                    transition: transform 0.2s, border-color 0.2s;
                }
                .olm-card:hover { border-color: rgba(99, 102, 241, 0.3); transform: translateY(-1px); }

                .olm-q-header { display: flex; gap: 12px; margin-bottom: 12px; }
                .olm-q-num {
                    flex-shrink: 0; width: 24px; height: 24px;
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    color: white; font-weight: 700; font-size: 12px;
                    border-radius: 6px; display: flex; align-items: center; justify-content: center;
                }
                .olm-q-text { font-size: 13px; line-height: 1.5; color: #f1f5f9; }
                .olm-q-text img { max-width: 100%; border-radius: 4px; }

                .olm-section {
                    margin-left: 36px; padding: 10px; border-radius: 8px; margin-bottom: 8px; position: relative;
                }
                .olm-ans-box { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); }
                .olm-sol-box { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); }

                .olm-label { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
                .olm-ans-label { color: #34d399; }
                .olm-sol-label { color: #60a5fa; }

                .olm-text-content { font-size: 13px; color: #e2e8f0; line-height: 1.5; }
                .olm-text-content p { margin: 0; }

                .olm-footer {
                    padding: 10px; text-align: center; font-size: 10px; color: #64748b;
                    border-top: 1px solid rgba(255, 255, 255, 0.05); background: rgba(0,0,0,0.2);
                }

                .olm-float-btn {
                    position: fixed; bottom: 30px; right: 30px;
                    width: 50px; height: 50px;
                    background: linear-gradient(135deg, #4f46e5, #ec4899);
                    border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 24px; color: white; cursor: pointer;
                    box-shadow: 0 4px 15px rgba(79, 70, 229, 0.5);
                    z-index: 999998; border: none;
                    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                    animation: pulse 3s infinite;
                }
                .olm-float-btn:hover { transform: scale(1.1) rotate(15deg); }
                .olm-float-btn.hidden { display: none; }

                /* MathJax overrides */
                .mjx-chtml { font-size: 110% !important; }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.textContent = styles;
            document.head.appendChild(styleSheet);
        }

        createUI() {
            this.container = document.createElement('div');
            this.container.className = 'olm-viewer-container';
            this.container.style.left = this.position.x + 'px';
            this.container.style.top = this.position.y + 'px';

            this.container.innerHTML = `
                <div class="olm-header">
                    <div class="olm-title-group">
                        <div class="olm-status-dot"></div>
                        <div class="olm-title">OLM SPACE</div>
                        <div class="olm-badge">0</div>
                    </div>
                    <div class="olm-controls">
                        <button class="olm-btn-icon olm-minimize" title="Thu gọn">_</button>
                        <button class="olm-btn-icon olm-btn-close olm-hide" title="Ẩn">×</button>
                    </div>
                </div>
                <div class="olm-toolbar">
                    <div class="olm-search-wrapper">
                        <span class="olm-search-icon">🔍</span>
                        <input type="text" class="olm-search" placeholder="Tìm kiếm câu hỏi...">
                    </div>
                    <button class="olm-btn-icon olm-clear" title="Xóa dữ liệu">🗑️</button>
                </div>
                <div class="olm-content">
                    <div style="text-align: center; padding: 40px 20px; color: #64748b;">
                        <div style="font-size: 40px; margin-bottom: 10px;">🪐</div>
                        <div>Đang quét dữ liệu từ vũ trụ OLM...</div>
                        <div style="font-size: 11px; margin-top: 5px;">Hãy làm bài để hiện đáp án</div>
                    </div>
                </div>
                <div class="olm-footer">Deep Space Edition v4.0 • NguyenTrongg</div>
            `;

            this.floatBtn = document.createElement('button');
            this.floatBtn.className = 'olm-float-btn hidden';
            this.floatBtn.innerHTML = '🚀';

            document.body.appendChild(this.container);
            document.body.appendChild(this.floatBtn);

            // Bind elements
            this.contentArea = this.container.querySelector('.olm-content');
            this.badge = this.container.querySelector('.olm-badge');
            this.searchInput = this.container.querySelector('.olm-search');
        }

        attachEvents() {
            // Drag Logic (Global)
            const header = this.container.querySelector('.olm-header');

            header.addEventListener('mousedown', (e) => {
                if(e.target.closest('button')) return;
                this.isDragging = true;
                const rect = this.container.getBoundingClientRect();
                this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                this.container.style.transition = 'none'; // Disable transition when dragging
            });

            document.addEventListener('mousemove', (e) => {
                if (!this.isDragging) return;
                e.preventDefault();
                let x = e.clientX - this.dragOffset.x;
                let y = e.clientY - this.dragOffset.y;

                // Bounds checking
                x = Math.max(0, Math.min(window.innerWidth - this.container.offsetWidth, x));
                y = Math.max(0, Math.min(window.innerHeight - this.container.offsetHeight, y));

                this.container.style.left = x + 'px';
                this.container.style.top = y + 'px';
            });

            document.addEventListener('mouseup', () => {
                if(this.isDragging) {
                    this.isDragging = false;
                    this.container.style.transition = 'height 0.3s ease, opacity 0.3s ease';
                }
            });

            // Buttons
            this.container.querySelector('.olm-minimize').addEventListener('click', () => {
                this.isMinimized = !this.isMinimized;
                this.container.classList.toggle('minimized', this.isMinimized);
            });

            this.container.querySelector('.olm-hide').addEventListener('click', () => this.toggleVisibility());
            this.floatBtn.addEventListener('click', () => this.toggleVisibility());

            this.container.querySelector('.olm-clear').addEventListener('click', () => {
                if(confirm('Xóa sạch dữ liệu đã thu thập?')) {
                    this.answers = [];
                    this.renderAnswers();
                }
            });

            this.searchInput.addEventListener('input', (e) => {
                this.searchTerm = e.target.value;
                this.renderAnswers();
            });

            // Shortcut
            document.addEventListener('keydown', (e) => {
                if (e.code === 'ShiftRight') this.toggleVisibility();
            });
        }

        toggleVisibility() {
            this.isVisible = !this.isVisible;
            this.container.classList.toggle('hidden', !this.isVisible);
            this.floatBtn.classList.toggle('hidden', this.isVisible);
        }

        addAnswers(data) {
            if (!Array.isArray(data)) return;

            const processed = data.map((q, i) => {
                const decoded = decodeBase64Utf8(q.content || '');
                if (!decoded) return null;

                let answers = null;
                if (q.json_content) answers = extractAnswerFromJSON(q.json_content);
                if (!answers) answers = extractAnswerFromHTML(decoded);

                const solution = extractSolution(decoded);
                // Simple ID check to prevent dupe
                const id = q.id || (decoded.substring(0, 20) + i);

                return {
                    id: id,
                    question: extractCleanQuestion(decoded, q.title),
                    answers: answers,
                    solution: solution,
                    timestamp: new Date().toLocaleTimeString('vi-VN')
                };
            }).filter(Boolean);

            // Merge and de-duplicate based on content hash/ID
            processed.forEach(newItem => {
                if (!this.answers.some(existing => existing.id === newItem.id)) {
                    this.answers.unshift(newItem);
                }
            });

            this.renderAnswers();
        }

        renderAnswers() {
            const filtered = this.answers.filter(item => {
                if (!this.searchTerm) return true;
                const div = document.createElement('div');
                div.innerHTML = item.question;
                return div.textContent.toLowerCase().includes(this.searchTerm.toLowerCase());
            });

            this.badge.textContent = this.answers.length;

            if (filtered.length === 0) {
                if (this.answers.length > 0) {
                    this.contentArea.innerHTML = `<div style="text-align:center; padding: 20px; color:#94a3b8;">Không tìm thấy kết quả nào</div>`;
                }
                return;
            }

            this.contentArea.innerHTML = filtered.map((item, index) => {
                let ansHTML = '';
                if (item.answers) {
                    const content = Array.isArray(item.answers)
                        ? `<ul style="margin:0; padding-left:15px;">${item.answers.map(a => `<li>${a}</li>`).join('')}</ul>`
                        : item.answers;
                    ansHTML = `
                        <div class="olm-section olm-ans-box">
                            <div class="olm-label olm-ans-label">✓ Đáp án</div>
                            <div class="olm-text-content">${content}</div>
                        </div>`;
                }

                let solHTML = '';
                if (item.solution) {
                    solHTML = `
                        <div class="olm-section olm-sol-box">
                            <div class="olm-label olm-sol-label">✎ Lời giải chi tiết</div>
                            <div class="olm-text-content">${item.solution}</div>
                        </div>`;
                }

                return `
                    <div class="olm-card">
                        <div class="olm-q-header">
                            <div class="olm-q-num">${filtered.length - index}</div>
                            <div class="olm-q-text">${item.question}</div>
                        </div>
                        ${ansHTML}
                        ${solHTML}
                        ${!ansHTML && !solHTML ? '<div class="olm-section" style="border:1px dashed #475569; color: #64748b; font-size:12px; font-style:italic;">⚠️ Chưa có dữ liệu đáp án</div>' : ''}
                    </div>
                `;
            }).join('');

            this.renderMath();
        }

        renderMath() {
            // Debounce render
            if (this.mathTimeout) clearTimeout(this.mathTimeout);
            this.mathTimeout = setTimeout(() => {
                const w = unsafeWindow || window;
                const container = this.contentArea;

                // 1. Try MathJax v3 (Promise-based)
                if (w.MathJax && w.MathJax.typesetPromise) {
                    w.MathJax.typesetPromise([container]).catch(err => console.log('MathJax v3 err:', err));
                }
                // 2. Try MathJax v2 (Hub Queue)
                else if (w.MathJax && w.MathJax.Hub) {
                    w.MathJax.Hub.Queue(["Typeset", w.MathJax.Hub, container]);
                }
                // 3. Try Katex (Manual render)
                else if (w.renderKatex) {
                    // Find elements with tex classes if necessary or just run on container
                    // Note: This is generic, OLM usually uses MathJax
                }
            }, 200);
        }
    }

    // ============ INITIALIZE & INTERCEPT ============
    const init = () => {
        console.log('🚀 OLM Deep Space Viewer v4 initialized');
        const viewer = new AnswerViewerUI();
        const w = unsafeWindow || window;

        // --- XHR Interception ---
        const originalOpen = w.XMLHttpRequest.prototype.open;
        const originalSend = w.XMLHttpRequest.prototype.send;

        w.XMLHttpRequest.prototype.open = function(method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        };

        w.XMLHttpRequest.prototype.send = function() {
            this.addEventListener('load', function() {
                const url = this._url || this.responseURL;
                if (url && (url.includes('get-question') || url.includes('/question'))) {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (Array.isArray(data)) viewer.addAnswers(data);
                        else if (data.data && Array.isArray(data.data)) viewer.addAnswers(data.data);
                        else if (data.questions && Array.isArray(data.questions)) viewer.addAnswers(data.questions);
                        else if (data.result && Array.isArray(data.result)) viewer.addAnswers(data.result);
                    } catch (e) {
                        // ignore parsing errors
                    }
                }
            });
            return originalSend.apply(this, arguments);
        };

        // --- Fetch Interception ---
        const originalFetch = w.fetch;
        w.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            const url = args[0] instanceof Request ? args[0].url : args[0];

            if (url && (url.includes('get-question') || url.includes('/question'))) {
                const clone = response.clone();
                clone.json().then(data => {
                    if (Array.isArray(data)) viewer.addAnswers(data);
                    else if (data.data && Array.isArray(data.data)) viewer.addAnswers(data.data);
                    else if (data.questions && Array.isArray(data.questions)) viewer.addAnswers(data.questions);
                    else if (data.result && Array.isArray(data.result)) viewer.addAnswers(data.result);
                }).catch(() => {});
            }
            return response;
        };
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
