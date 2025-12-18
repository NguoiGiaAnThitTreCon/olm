// ==UserScript==
// @name         OLM Answer Viewer - Space Edition (Fixed)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Xem đáp án OLM tự động - Giao diện vũ trụ đen trắng (Fixed drag & match all pages)
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
            console.error("Lỗi giải mã Base64:", e);
            return null;
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
                if (node.children) {
                    node.children.forEach(child => findAllCorrect(child));
                }
            };

            const extractText = (node) => {
                if (!node) return '';
                let text = node.text || '';
                if (node.children) {
                    text += node.children.map(extractText).join('');
                }
                return text.trim();
            };

            findAllCorrect(jsonData.root);
            return answers.length > 0 ? answers : null;
        } catch (e) {
            console.error("Lỗi parse JSON:", e);
            return null;
        }
    };

    const extractAnswerFromHTML = (html) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const answers = [];

        const selectors = [
            '.correctAnswer',
            '.correct-answer',
            '[data-correct="true"]',
            '.answer.correct',
            'input[type="radio"][checked]',
            'input[type="checkbox"][checked]',
            '.selected.correct',
            'li.correct',
            'div.correct',
            'span.correct'
        ];

        selectors.forEach(selector => {
            const elements = tempDiv.querySelectorAll(selector);
            elements.forEach(el => {
                const text = el.textContent.trim();
                if (text && !answers.includes(text)) {
                    answers.push(text);
                }
            });
        });

        const fillInInputs = tempDiv.querySelectorAll('input[data-accept]');
        fillInInputs.forEach(input => {
            const acceptValues = input.getAttribute('data-accept').split('|');
            acceptValues.forEach(val => {
                const text = val.trim();
                if (text && !answers.includes(text)) {
                    answers.push(text);
                }
            });
        });

        const answerElements = tempDiv.querySelectorAll('[data-answer], [answer]');
        answerElements.forEach(el => {
            const answer = el.getAttribute('data-answer') || el.getAttribute('answer');
            if (answer && !answers.includes(answer.trim())) {
                answers.push(answer.trim());
            }
        });

        return answers.length > 0 ? answers : null;
    };

    const extractSolution = (html) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        const selectors = [
            '.loigiai',
            '.huong-dan-giai',
            '.explain',
            '.explanation',
            '.solution',
            '#solution',
            '.guide',
            '.exp',
            '.exp-in',
            '.giai-chi-tiet',
            '.detailed-solution',
            '[class*="solution"]',
            '[class*="explain"]',
            '[class*="loigiai"]'
        ];

        for (const selector of selectors) {
            const element = tempDiv.querySelector(selector);
            if (element) {
                element.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
                    if (h.textContent.trim().match(/^(lời giải|hướng dẫn|giải|solution|explain)/i)) {
                        h.remove();
                    }
                });

                const content = element.innerHTML.trim();
                if (content) return element;
            }
        }
        return null;
    };

    const extractCleanQuestion = (html, title) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        const removeSelectors = [
            'ol.quiz-list',
            'ul.quiz-list',
            '.interaction',
            '.form-group',
            '.loigiai',
            '.huong-dan-giai',
            '.explain',
            '.explanation',
            '.solution',
            '#solution',
            '.guide',
            '.exp',
            '.exp-in',
            '.answer-section',
            '.correctAnswer',
            '.correct-answer',
            '[data-correct]',
            'script',
            'style'
        ];

        removeSelectors.forEach(selector => {
            tempDiv.querySelectorAll(selector).forEach(el => el.remove());
        });

        let content = tempDiv.innerHTML.trim();

        if (!content || content.length < 10) {
            content = title || 'Câu hỏi';
        }

        return content;
    };

    // ============ UI CLASS ============
    class AnswerViewerUI {
        constructor() {
            this.answers = [];
            this.isVisible = true;
            this.isMinimized = false;
            this.searchTerm = '';
            this.position = { x: 20, y: 20 };
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
                @keyframes slideIn {
                    from { transform: translateX(-100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes twinkle {
                    0%, 100% { opacity: 1; box-shadow: 0 0 4px #fff; }
                    50% { opacity: 0.4; box-shadow: 0 0 2px #fff; }
                }
                @keyframes float {
                    0%, 100% { transform: translateY(0px); }
                    50% { transform: translateY(-8px); }
                }

                .olm-viewer-container {
                    position: fixed !important;
                    width: 480px;
                    max-height: 85vh;
                    background: #000000;
                    border-radius: 16px;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.8), 0 0 0 1px #333;
                    z-index: 2147483647 !important;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    animation: slideIn 0.4s ease-out;
                    overflow: hidden;
                }

                .olm-viewer-container::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-image:
                        radial-gradient(1px 1px at 20% 30%, white, transparent),
                        radial-gradient(1px 1px at 60% 70%, white, transparent),
                        radial-gradient(1px 1px at 50% 50%, white, transparent),
                        radial-gradient(2px 2px at 80% 10%, white, transparent),
                        radial-gradient(1px 1px at 90% 60%, white, transparent),
                        radial-gradient(1px 1px at 33% 85%, white, transparent),
                        radial-gradient(2px 2px at 75% 25%, white, transparent),
                        radial-gradient(1px 1px at 15% 60%, white, transparent),
                        radial-gradient(1px 1px at 45% 15%, white, transparent);
                    background-repeat: repeat;
                    background-size: 200px 200px, 300px 300px, 150px 150px, 250px 250px, 180px 180px, 220px 220px, 270px 270px, 160px 160px, 190px 190px;
                    animation: twinkle 4s infinite;
                    pointer-events: none;
                    opacity: 0.8;
                }

                .olm-viewer-container.minimized { max-height: 56px; }
                .olm-viewer-container.hidden { display: none !important; }

                .olm-header {
                    background: #000000;
                    color: white;
                    padding: 14px 18px;
                    border-radius: 16px 16px 0 0;
                    cursor: move;
                    user-select: none;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    border-bottom: 1px solid #333;
                    position: relative;
                    z-index: 2;
                }

                .olm-header-left {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .olm-pulse {
                    width: 8px;
                    height: 8px;
                    background: #fff;
                    border-radius: 50%;
                    animation: twinkle 2s infinite;
                }

                .olm-title {
                    font-weight: 700;
                    font-size: 14px;
                    letter-spacing: 0.5px;
                    text-shadow: 0 0 8px rgba(255,255,255,0.8);
                }

                .olm-badge {
                    background: #fff;
                    color: #000;
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: 700;
                }

                .olm-header-right {
                    display: flex;
                    gap: 6px;
                }

                .olm-btn {
                    background: #1a1a1a;
                    border: 1px solid #333;
                    color: white;
                    width: 30px;
                    height: 30px;
                    border-radius: 8px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 16px;
                    transition: all 0.2s;
                }

                .olm-btn:hover {
                    background: #2a2a2a;
                    border-color: #fff;
                }

                .olm-toolbar {
                    padding: 12px 14px;
                    background: #000;
                    border-bottom: 1px solid #333;
                    display: flex;
                    gap: 8px;
                    position: relative;
                    z-index: 2;
                }

                .olm-search {
                    flex: 1;
                    padding: 9px 14px 9px 36px;
                    border: 1px solid #333;
                    border-radius: 10px;
                    font-size: 13px;
                    outline: none;
                    background: #1a1a1a;
                    color: white;
                    transition: all 0.2s;
                }

                .olm-search::placeholder { color: #666; }

                .olm-search:focus {
                    border-color: #fff;
                    background: #0a0a0a;
                }

                .olm-search-icon {
                    position: absolute;
                    left: 26px;
                    top: 50%;
                    transform: translateY(-50%);
                    font-size: 14px;
                    pointer-events: none;
                }

                .olm-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 14px;
                    position: relative;
                    z-index: 2;
                    background: #000;
                }

                .olm-content::-webkit-scrollbar { width: 6px; }
                .olm-content::-webkit-scrollbar-track {
                    background: #1a1a1a;
                }
                .olm-content::-webkit-scrollbar-thumb {
                    background: #333;
                    border-radius: 3px;
                }
                .olm-content::-webkit-scrollbar-thumb:hover {
                    background: #444;
                }

                .olm-empty {
                    text-align: center;
                    padding: 50px 20px;
                    color: #666;
                }

                .olm-question-card {
                    background: #0a0a0a;
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 14px;
                    border: 1px solid #1a1a1a;
                    transition: all 0.3s;
                }

                .olm-question-card:hover {
                    border-color: #333;
                    box-shadow: 0 0 20px rgba(255,255,255,0.1);
                }

                .olm-question-header {
                    display: flex;
                    gap: 12px;
                    margin-bottom: 12px;
                }

                .olm-question-number {
                    flex-shrink: 0;
                    width: 30px;
                    height: 30px;
                    background: #fff;
                    color: #000;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 900;
                    font-size: 13px;
                    box-shadow: 0 0 16px rgba(255,255,255,0.6);
                    animation: float 3s ease-in-out infinite;
                }

                .olm-question-text {
                    flex: 1;
                    font-size: 13px;
                    line-height: 1.6;
                    color: #fff;
                }

                .olm-answer-box {
                    margin-left: 42px;
                    background: #0d1a0d;
                    border-left: 3px solid #4ade80;
                    border-radius: 0 10px 10px 0;
                    padding: 12px;
                    margin-bottom: 10px;
                }

                .olm-answer-label {
                    font-size: 10px;
                    font-weight: 700;
                    color: #4ade80;
                    margin-bottom: 6px;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }

                .olm-answer-content {
                    font-size: 12px;
                    font-weight: 600;
                    color: #fff;
                    line-height: 1.5;
                }

                .olm-answer-content ul {
                    margin: 0;
                    padding-left: 18px;
                }

                .olm-answer-content li {
                    margin: 5px 0;
                }

                .olm-solution-box {
                    margin-left: 42px;
                    background: #0a0d1a;
                    border-left: 3px solid #60a5fa;
                    border-radius: 0 10px 10px 0;
                    padding: 12px;
                    margin-bottom: 10px;
                }

                .olm-solution-label {
                    font-size: 10px;
                    font-weight: 700;
                    color: #60a5fa;
                    margin-bottom: 6px;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }

                .olm-solution-content {
                    font-size: 12px;
                    color: #fff;
                    line-height: 1.5;
                }

                .olm-no-data {
                    margin-left: 42px;
                    font-size: 11px;
                    color: #666;
                    font-style: italic;
                }

                .olm-timestamp {
                    margin-left: 42px;
                    margin-top: 8px;
                    font-size: 10px;
                    color: #444;
                }

                .olm-footer {
                    background: #000;
                    padding: 10px;
                    text-align: center;
                    border-top: 1px solid #333;
                    border-radius: 0 0 16px 16px;
                    font-size: 10px;
                    color: #666;
                    position: relative;
                    z-index: 2;
                }

                .olm-footer strong {
                    color: #fff;
                }

                .olm-float-btn {
                    position: fixed !important;
                    bottom: 30px !important;
                    right: 30px !important;
                    width: 56px;
                    height: 56px;
                    background: #fff;
                    color: #000;
                    border: 2px solid #333;
                    border-radius: 50%;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.4);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    z-index: 2147483646 !important;
                    transition: all 0.3s;
                    animation: float 3s ease-in-out infinite;
                }

                .olm-float-btn:hover {
                    transform: scale(1.1) rotate(180deg);
                    box-shadow: 0 6px 24px rgba(0,0,0,0.8), 0 0 30px rgba(255,255,255,0.6);
                }
                .olm-float-btn.hidden { display: none !important; }
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

            const header = document.createElement('div');
            header.className = 'olm-header';
            header.innerHTML = `
                <div class="olm-header-left">
                    <div class="olm-pulse"></div>
                    <div class="olm-title">⭐ SPACE VIEWER</div>
                    <div class="olm-badge">0</div>
                </div>
                <div class="olm-header-right">
                    <button class="olm-btn olm-minimize" title="Thu gọn">−</button>
                    <button class="olm-btn olm-hide" title="Ẩn">×</button>
                </div>
            `;

            const toolbar = document.createElement('div');
            toolbar.className = 'olm-toolbar';
            toolbar.innerHTML = `
                <div style="position: relative; flex: 1;">
                    <span class="olm-search-icon">🔍</span>
                    <input type="text" class="olm-search" placeholder="Tìm kiếm...">
                </div>
                <button class="olm-btn" style="width: auto; padding: 0 12px;" title="Xóa tất cả">🔄</button>
                <button class="olm-btn" style="width: auto; padding: 0 12px;" title="Xuất file">💾</button>
            `;

            this.contentArea = document.createElement('div');
            this.contentArea.className = 'olm-content';
            this.contentArea.innerHTML = `
                <div class="olm-empty">
                    <div style="font-size: 48px; margin-bottom: 14px; animation: float 3s ease-in-out infinite;">🌌</div>
                    <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: white;">Vũ trụ đang chờ đợi</div>
                    <div style="font-size: 11px;">Làm bài tập để khám phá các ngôi sao đáp án</div>
                </div>
            `;

            const footer = document.createElement('div');
            footer.className = 'olm-footer';
            footer.innerHTML = 'Created by <strong>NguyenTrongg</strong> × <strong>Claude AI</strong>';

            this.floatBtn = document.createElement('button');
            this.floatBtn.className = 'olm-float-btn hidden';
            this.floatBtn.innerHTML = '⭐';

            this.container.append(header, toolbar, this.contentArea, footer);

            document.body.appendChild(this.container);
            document.body.appendChild(this.floatBtn);

            this.badge = header.querySelector('.olm-badge');
            this.searchInput = toolbar.querySelector('.olm-search');
            this.clearBtn = toolbar.querySelectorAll('.olm-btn')[0];
            this.exportBtn = toolbar.querySelectorAll('.olm-btn')[1];
            this.minimizeBtn = header.querySelector('.olm-minimize');
            this.hideBtn = header.querySelector('.olm-hide');
        }

        attachEvents() {
            const headerEl = this.container.querySelector('.olm-header');

            headerEl.addEventListener('mousedown', (e) => {
                if (e.target.closest('.olm-btn')) return;
                this.isDragging = true;
                const rect = this.container.getBoundingClientRect();
                this.dragOffset = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!this.isDragging) return;

                const newX = e.clientX - this.dragOffset.x;
                const newY = e.clientY - this.dragOffset.y;

                const maxX = window.innerWidth - this.container.offsetWidth;
                const maxY = window.innerHeight - this.container.offsetHeight;

                this.position.x = Math.max(0, Math.min(maxX, newX));
                this.position.y = Math.max(0, Math.min(maxY, newY));

                this.container.style.left = this.position.x + 'px';
                this.container.style.top = this.position.y + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (this.isDragging) {
                    this.isDragging = false;
                    document.body.style.userSelect = '';
                }
            });

            this.minimizeBtn.addEventListener('click', () => this.toggleMinimize());
            this.hideBtn.addEventListener('click', () => this.toggleVisibility());
            this.floatBtn.addEventListener('click', () => this.toggleVisibility());
            this.clearBtn.addEventListener('click', () => this.clearAll());
            this.exportBtn.addEventListener('click', () => this.exportToTxt());

            this.searchInput.addEventListener('input', (e) => {
                this.searchTerm = e.target.value;
                this.renderAnswers();
            });

            document.addEventListener('keydown', (e) => {
                if (e.code === 'ShiftRight') {
                    this.toggleVisibility();
                }
            });
        }

        toggleMinimize() {
            this.isMinimized = !this.isMinimized;
            this.container.classList.toggle('minimized', this.isMinimized);
            this.minimizeBtn.textContent = this.isMinimized ? '+' : '−';
        }

        toggleVisibility() {
            this.isVisible = !this.isVisible;
            this.container.classList.toggle('hidden', !this.isVisible);
            this.floatBtn.classList.toggle('hidden', this.isVisible);
        }

        clearAll() {
            if (confirm('Xóa tất cả các đáp án?')) {
                this.answers = [];
                this.renderAnswers();
            }
        }

        addAnswers(data) {
            if (!Array.isArray(data)) {
                console.log('❌ Data không phải array:', data);
                return;
            }

            console.log('📊 Nhận được:', data.length, 'câu hỏi');

            const processed = data.map((q, i) => {
                const decoded = decodeBase64Utf8(q.content || '');
                if (!decoded) return null;

                let answers = null;
                let solution = null;

                if (q.json_content) {
                    answers = extractAnswerFromJSON(q.json_content);
                }
                if (!answers) {
                    answers = extractAnswerFromHTML(decoded);
                }

                const solutionEl = extractSolution(decoded);
                if (solutionEl) {
                    solution = solutionEl.innerHTML;
                }

                return {
                    id: q.id || Date.now() + i,
                    question: extractCleanQuestion(decoded, q.title),
                    answers: answers,
                    solution: solution,
                    rawContent: decoded,
                    timestamp: new Date().toLocaleTimeString('vi-VN')
                };
            }).filter(Boolean);

            console.log('✅ Đã xử lý:', processed.length, 'câu');

            this.answers = [...processed, ...this.answers];
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
                this.contentArea.innerHTML = `
                    <div class="olm-empty">
                        <div style="font-size: 48px; margin-bottom: 14px; animation: float 3s ease-in-out infinite;">
                            ${this.searchTerm ? '🔍' : '🌌'}
                        </div>
                        <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: white;">
                            ${this.searchTerm ? 'Không tìm thấy' : 'Vũ trụ đang chờ đợi'}
                        </div>
                        <div style="font-size: 11px;">
                            ${this.searchTerm ? 'Thử từ khóa khác' : 'Làm bài tập để khám phá đáp án'}
                        </div>
                    </div>
                `;
                return;
            }

            this.contentArea.innerHTML = filtered.map((item, index) => {
                let answerHTML = '';
                if (item.answers) {
                    const content = Array.isArray(item.answers)
                        ? '<ul style="margin: 0; padding-left: 18px;">' + item.answers.map(a => '<li>' + a + '</li>').join('') + '</ul>'
                        : item.answers;
                    answerHTML = `
                        <div class="olm-answer-box">
                            <div class="olm-answer-label">✓ ĐÁP ÁN</div>
                            <div class="olm-answer-content">${content}</div>
                        </div>
                    `;
                }

                let solutionHTML = '';
                if (item.solution) {
                    solutionHTML = `
                        <div class="olm-solution-box">
                            <div class="olm-solution-label">📝 LỜI GIẢI</div>
                            <div class="olm-solution-content">${item.solution}</div>
                        </div>
                    `;
                }

                let noDataHTML = '';
                if (!item.answers && !item.solution) {
                    noDataHTML = '<div class="olm-no-data">⚠️ Chưa có đáp án</div>';
                }

                return `
                    <div class="olm-question-card">
                        <div class="olm-question-header">
                            <div class="olm-question-number">${filtered.length - index}</div>
                            <div class="olm-question-text">${item.question}</div>
                        </div>
                        ${answerHTML}
                        ${solutionHTML}
                        ${noDataHTML}
                        <div class="olm-timestamp">⏱️ ${item.timestamp}</div>
                    </div>
                `;
            }).join('');

            this.renderMath();
        }

        renderMath() {
            setTimeout(() => {
                const w = unsafeWindow || window;
                const renderFunc = w.renderKatex ||
                    (w.MathJax && (w.MathJax.typeset ||
                    (w.MathJax.Hub && w.MathJax.Hub.Queue)));

                if (typeof renderFunc === 'function') {
                    try {
                        if (w.MathJax && w.MathJax.typeset) {
                            w.MathJax.typeset([this.contentArea]);
                        } else if (w.MathJax && w.MathJax.Hub) {
                            w.MathJax.Hub.Queue(["Typeset", w.MathJax.Hub, this.contentArea]);
                        } else {
                            renderFunc(this.contentArea);
                        }
                    } catch (e) {
                        console.error("Lỗi render math:", e);
                    }
                }
            }, 400);
        }

        exportToTxt() {
            let text = '⭐ ĐÁP ÁN OLM - SPACE VIEWER\n';
            text += 'Thời gian: ' + new Date().toLocaleString('vi-VN') + '\n';
            text += '='.repeat(60) + '\n\n';

            this.answers.forEach((item, index) => {
                const div = document.createElement('div');
                div.innerHTML = item.question;
                const questionText = div.textContent.trim();

                text += '🌟 Câu ' + (index + 1) + ': ' + questionText + '\n';
                text += '-'.repeat(60) + '\n';

                if (item.answers) {
                    text += '✓ ĐÁP ÁN:\n';
                    if (Array.isArray(item.answers)) {
                        item.answers.forEach((ans, i) => {
                            div.innerHTML = ans;
                            text += '   ' + (i + 1) + '. ' + div.textContent.trim() + '\n';
                        });
                    } else {
                        div.innerHTML = item.answers;
                        text += '   ' + div.textContent.trim() + '\n';
                    }
                    text += '\n';
                }

                if (item.solution) {
                    div.innerHTML = item.solution;
                    const solutionText = div.textContent.trim();
                    text += '📝 LỜI GIẢI:\n   ' + solutionText + '\n\n';
                }

                if (!item.answers && !item.solution) {
                    text += '⚠️ Không có đáp án\n\n';
                }

                text += '\n';
            });

            text += '='.repeat(60) + '\n';
            text += 'Tổng: ' + this.answers.length + ' câu\n';
            text += 'NguyenTrongg × Claude AI\n';

            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'olm-answers-' + Date.now() + '.txt';
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    // ============ INITIALIZE ============
    const initExtension = () => {
        console.log('🚀 OLM Space Viewer đang khởi động...');
        const viewer = new AnswerViewerUI();

        const w = unsafeWindow || window;

        // Intercept XHR
        const XHR = w.XMLHttpRequest;
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function(method, url, ...rest) {
            this._url = url;
            this._method = method;
            return originalOpen.call(this, method, url, ...rest);
        };

        XHR.prototype.send = function(...args) {
            const xhr = this;

            const originalOnReadyStateChange = xhr.onreadystatechange;
            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    const url = xhr._url || xhr.responseURL;

                    if (url && (url.includes('get-question') || url.includes('question'))) {
                        console.log('🎯 [XHR] Tìm thấy API:', url);

                        try {
                            const data = JSON.parse(xhr.responseText);
                            console.log('✅ [XHR] Data:', data);

                            if (Array.isArray(data)) {
                                viewer.addAnswers(data);
                            } else if (data.data && Array.isArray(data.data)) {
                                viewer.addAnswers(data.data);
                            } else if (data.questions && Array.isArray(data.questions)) {
                                viewer.addAnswers(data.questions);
                            } else if (data.result && Array.isArray(data.result)) {
                                viewer.addAnswers(data.result);
                            }
                        } catch (e) {
                            console.error('❌ [XHR] Lỗi:', e);
                        }
                    }
                }

                if (originalOnReadyStateChange) {
                    return originalOnReadyStateChange.apply(this, arguments);
                }
            };

            xhr.addEventListener('load', function() {
                const url = xhr._url || xhr.responseURL;
                if (xhr.status === 200 && url && (url.includes('get-question') || url.includes('question'))) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (Array.isArray(data)) {
                            viewer.addAnswers(data);
                        } else if (data.data) {
                            viewer.addAnswers(data.data);
                        } else if (data.questions) {
                            viewer.addAnswers(data.questions);
                        } else if (data.result) {
                            viewer.addAnswers(data.result);
                        }
                    } catch (e) {
                        // Silent fail
                    }
                }
            });

            return originalSend.apply(this, args);
        };

        // Intercept Fetch API
        const originalFetch = w.fetch;
        w.fetch = function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

            const promise = originalFetch.apply(this, args);

            if (url && (url.includes('get-question') || url.includes('question'))) {
                console.log('🎯 [FETCH] Tìm thấy API:', url);

                promise.then(response => {
                    if (response.ok) {
                        response.clone().json()
                            .then(data => {
                                console.log('✅ [FETCH] Data:', data);

                                if (Array.isArray(data)) {
                                    viewer.addAnswers(data);
                                } else if (data.data && Array.isArray(data.data)) {
                                    viewer.addAnswers(data.data);
                                } else if (data.questions && Array.isArray(data.questions)) {
                                    viewer.addAnswers(data.questions);
                                } else if (data.result && Array.isArray(data.result)) {
                                    viewer.addAnswers(data.result);
                                }
                            })
                            .catch(err => console.error('❌ [FETCH] Lỗi parse:', err));
                    }
                }).catch(err => console.error('❌ [FETCH] Lỗi request:', err));
            }

            return promise;
        };

        console.log('✅ OLM Space Viewer sẵn sàng!');
        console.log('💡 Nhấn Shift phải để ẩn/hiện UI');
        console.log('🔍 Đang theo dõi requests...');
    };

    // Khởi động khi DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initExtension);
    } else {
        initExtension();
    }
})();
