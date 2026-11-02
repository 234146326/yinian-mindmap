/* 右侧内容面板：标题、笔记、媒体、参考资料、标签、颜色 */

import { escapeHtml, formatDate, byteSize, debounce, uid } from './util.js';
import { icon, toast } from './ui.js';
import { renderMarkdown, plainSummary } from './md.js';
import { NODE_COLOR_PALETTE, stats } from './model.js';

const KIND_LABEL = { image: '图片', video: '视频', link: '链接', ref: '资料' };

export function createInspector({ bodyEl, crumbEl, hooks }) {
  let currentId = null;
  let mode = 'edit'; // 笔记模式
  let pendingRender = null;

  const render = (node, ctx = {}) => {
    const same = node && node.id === currentId;
    if (node && same && !ctx.force) {
      // 同一节点：仅刷新徽标/统计，不打断正在输入的控件
      updateStats(node, ctx);
      return;
    }
    currentId = node ? node.id : null;
    if (!node) {
      crumbEl.textContent = '未选择节点';
      bodyEl.innerHTML = `<div class="empty-hint"><span class="empty-emoji">${icon(
        'cursor',
      )}</span><p>选择一个节点查看与编辑内容</p></div>`;
      return;
    }
    crumbEl.textContent = ctx.crumb || node.title;
    bodyEl.innerHTML = template(node, ctx);
    bind(node, ctx);
    if (hooks.renderFields) hooks.renderFields(node, ctx, bodyEl.querySelector('[data-role="rule-fields"]'));
    loadThumbs(node, ctx);
  };

  const updateStats = (node, ctx) => {
    const s = stats(node);
    const set = (key, val) => {
      const el = bodyEl.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = val;
    };
    set('children', String((node.children || []).length));
    set('nodes', String(s.nodes));
    set('updated', formatDate(node.updatedAt).slice(5));
    const count = bodyEl.querySelector('[data-att-count]');
    if (count) count.textContent = `${(node.attachments || []).length}`;
    const ep = bodyEl.querySelector('[data-role="episodes"]');
    if (ep) {
      const input = ep.querySelector('[data-episodes-input]');
      const hint = ep.querySelector('[data-episodes-hint]');
      if (input && document.activeElement !== input) input.value = String((node.children || []).length);
      if (hint) hint.textContent = `当前实际 ${(node.children || []).length} 个子节点 · 填更大的数字只补齐差额，填更小不会删除`;
    }
    const titleInput = bodyEl.querySelector('[data-role="title"]');
    if (titleInput && document.activeElement !== titleInput) titleInput.value = node.title;
    if (ctx.crumb) crumbEl.textContent = ctx.crumb;
  };

  const template = (node, ctx) => {
    const atts = node.attachments || [];
    const s = stats(node);
    const tags = node.tags || [];
    const rule = ctx.rule || null;
    const ruleLocked = (node.children || []).length > 0;
    return `
      <div class="insp-section rule-card">
        <div class="insp-label">
          <span>节点规则详情</span>
          <span class="rule-chip">${escapeHtml(rule ? rule.template.name : '自由导图')}</span>
        </div>
        <div class="rule-summary">
          <span>${
            rule && rule.sourceTitle
              ? `由父节点「${escapeHtml(rule.sourceTitle)}」决定`
              : rule && rule.detached
                ? '沿用脱离时继承的规则'
                : '默认模板（根节点）'
          }</span>
          <span>·</span>
          <span>当前节点有 ${rule ? rule.template.fields.length : 0} 个属性</span>
          ${ruleLocked ? '<span class="rule-warn">改向下规则会影响这些子节点</span>' : ''}
        </div>
        <button class="btn btn-sm btn-block" data-act="open-rule">打开规则层</button>
      </div>

      <div class="insp-section">
        <div class="insp-label">标题</div>
        <input class="insp-input insp-title-input" data-role="title" value="${escapeHtml(node.title)}" spellcheck="false" />
      </div>

      <div class="insp-section">
        <div class="insp-label">
          <span>笔记</span>
          <span class="segmented" data-role="note-mode">
            <button data-mode="edit" class="${mode === 'edit' ? 'is-active' : ''}">编辑</button>
            <button data-mode="preview" class="${mode === 'preview' ? 'is-active' : ''}">预览</button>
          </span>
        </div>
        <textarea class="insp-textarea" data-role="note" placeholder="记录想法、细节、引用……支持 Markdown">${escapeHtml(
          node.note || '',
        )}</textarea>
        <div class="md-preview" data-role="preview" ${mode === 'edit' ? 'hidden' : ''}>${
          renderMarkdown(node.note) || '<span style="color:var(--ink-3)">暂无内容</span>'
        }</div>
        <div class="form-hint">支持 # 标题、**粗体**、- 列表、\`代码\`、[链接](url)</div>
      </div>

      <div data-role="rule-fields" hidden></div>

      <div class="insp-section">
        <div class="insp-label">
          <span>媒体与参考资料 <span class="count">(<span data-att-count>${atts.length}</span>)</span></span>
        </div>
        <div class="attach-list" data-role="attachments">${atts.map(attCard).join('')}</div>
        <div class="attach-add">
          <button class="btn btn-sm" data-act="add-media">${icon('image')}图片/视频</button>
          <button class="btn btn-sm" data-act="add-link">${icon('link')}链接/资料</button>
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-label">标签</div>
        <input class="insp-input" data-role="tag-input" placeholder="输入后回车添加" spellcheck="false" />
        <div class="tag-row" data-role="tags">${tags
          .map(
            (t, i) =>
              `<span class="tag">${escapeHtml(t)}<button data-act="del-tag" data-i="${i}" aria-label="移除标签">${icon(
                'close',
              )}</button></span>`,
          )
          .join('')}</div>
      </div>

      <div class="insp-section">
        <div class="insp-label">标记颜色</div>
        <div class="swatches" data-role="swatches">
          ${NODE_COLOR_PALETTE.map(
            (c, i) =>
              `<button class="swatch ${c ? '' : 'is-none'} ${
                (node.color || null) === c ? 'is-active' : ''
              }" data-color="${c || ''}" title="${c || '无'}" style="${c ? `background:${c}` : ''}"></button>`,
          ).join('')}
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-label">节点信息</div>
        <div class="node-meta-grid">
          <div>直属子节点<b data-stat="children">${(node.children || []).length}</b></div>
          <div>子树节点<b data-stat="nodes">${s.nodes}</b></div>
          <div>创建于<b>${escapeHtml(formatDate(node.createdAt).slice(5))}</b></div>
          <div>更新于<b data-stat="updated">${escapeHtml(formatDate(node.updatedAt).slice(5))}</b></div>
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-label">操作</div>
        <div class="insp-actions">
          <button class="btn btn-sm" data-act="export-node">${icon('download')}导出该节点</button>
          <button class="btn btn-sm" data-act="copy-outline">${icon('copy')}复制大纲</button>
          <button class="btn btn-sm" data-act="add-child">${icon('plus')}添加子节点</button>
          <button class="btn btn-sm btn-danger" data-act="delete-node" ${
            ctx.isRoot ? 'disabled title="根节点不能删除"' : ''
          }>${icon('trash')}删除节点</button>
        </div>
      </div>`;
  };

  function attCard(att) {
    const kind = att.kind || 'link';
    const iconName = kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'ref' ? 'ref' : 'link';
    const sub = att.mediaId
      ? `${KIND_LABEL[kind]} · ${byteSize(att.size || 0)}`
      : att.url
        ? att.url.replace(/^https?:\/\//, '').slice(0, 40)
        : KIND_LABEL[kind];
    return `<div class="attach-card" data-att="${att.id}">
      <div class="attach-thumb" data-act="open">${icon(iconName)}</div>
      <div class="attach-info">
        <div class="attach-title">${escapeHtml(att.title || att.name || KIND_LABEL[kind])}</div>
        <div class="attach-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="attach-acts">
        <button class="icon-btn small" data-act="open" title="预览 / 打开">${icon('eye')}</button>
        ${
          att.url
            ? `<button class="icon-btn small" data-act="copy-url" title="复制链接">${icon('copy')}</button>`
            : ''
        }
        <button class="icon-btn small" data-act="remove-att" title="移除">${icon('trash')}</button>
      </div>
    </div>`;
  }

  async function loadThumbs(node, ctx) {
    const imgs = (node.attachments || []).filter((a) => a.kind === 'image' && a.mediaId);
    for (const att of imgs) {
      if (node.id !== currentId) return;
      const url = await hooks.mediaUrl(att.mediaId);
      if (!url) continue;
      const card = bodyEl.querySelector(`[data-att="${att.id}"] .attach-thumb`);
      if (card) card.innerHTML = `<img src="${url}" alt="${escapeHtml(att.title || '')}" />`;
    }
    void ctx;
  }

  function bind(node, ctx) {
    const titleInput = bodyEl.querySelector('[data-role="title"]');
    const noteEl = bodyEl.querySelector('[data-role="note"]');
    const previewEl = bodyEl.querySelector('[data-role="preview"]');
    const tagInput = bodyEl.querySelector('[data-role="tag-input"]');

    const commitTitle = debounce((value) => {
      hooks.updateNode(node.id, { title: value.trim() || '未命名节点' });
    }, 260);
    titleInput.addEventListener('input', () => commitTitle(titleInput.value));
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleInput.blur();
      }
    });
    titleInput.addEventListener('blur', () => {
      if (!titleInput.value.trim()) {
        titleInput.value = '未命名节点';
        hooks.updateNode(node.id, { title: '未命名节点' });
      }
    });

    const commitNote = debounce((value) => {
      hooks.updateNode(node.id, { note: value });
    }, 420);
    noteEl.addEventListener('input', () => {
      commitNote(noteEl.value);
      if (!previewEl.hidden) previewEl.innerHTML = renderMarkdown(noteEl.value) || '';
    });
    noteEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        commitNote.flush(noteEl.value);
        toast('笔记已保存', { type: 'ok' });
      }
    });

    bodyEl.querySelectorAll('[data-role="note-mode"] button').forEach((btn) => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        bodyEl.querySelectorAll('[data-role="note-mode"] button').forEach((b) => {
          b.classList.toggle('is-active', b.dataset.mode === mode);
        });
        noteEl.hidden = mode !== 'edit';
        previewEl.hidden = mode !== 'preview';
        if (mode === 'preview') {
          previewEl.innerHTML = renderMarkdown(noteEl.value) || '<span style="color:var(--ink-3)">暂无内容</span>';
        } else {
          noteEl.focus();
        }
      });
    });

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        const value = tagInput.value.replace(/[,，]/g, '').trim();
        if (!value) return;
        const tags = [...(node.tags || [])];
        if (!tags.includes(value)) tags.push(value.slice(0, 40));
        tagInput.value = '';
        hooks.updateNode(node.id, { tags }, { force: true });
      }
    });

    bodyEl.querySelector('[data-role="tags"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="del-tag"]');
      if (!btn) return;
      const tags = [...(node.tags || [])];
      tags.splice(Number(btn.dataset.i), 1);
      hooks.updateNode(node.id, { tags }, { force: true });
    });

    bodyEl.querySelector('[data-role="swatches"]').addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      hooks.updateNode(node.id, { color: sw.dataset.color || null }, { force: true });
    });

    bodyEl.querySelector('[data-role="attachments"]').addEventListener('click', (e) => {
      const card = e.target.closest('[data-att]');
      if (!card) return;
      const att = (node.attachments || []).find((a) => a.id === card.dataset.att);
      if (!att) return;
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'open') hooks.openAttachment(att);
      else if (act.dataset.act === 'copy-url') hooks.copyText(att.url, '链接已复制');
      else if (act.dataset.act === 'remove-att') hooks.removeAttachment(node.id, att.id);
    });

    bodyEl.querySelector('[data-act="add-media"]').addEventListener('click', () => hooks.pickMedia(node.id));
    bodyEl.querySelector('[data-act="add-link"]').addEventListener('click', () => hooks.addLinkDialog(node.id));
    bodyEl.querySelector('[data-act="export-node"]').addEventListener('click', () => hooks.exportNode(node.id));
    bodyEl.querySelector('[data-act="copy-outline"]').addEventListener('click', () => hooks.copyOutline(node.id));
    bodyEl.querySelector('[data-act="add-child"]').addEventListener('click', () => hooks.addChild(node.id));
    const ruleBtn = bodyEl.querySelector('[data-act="open-rule"]');
    if (ruleBtn) ruleBtn.addEventListener('click', () => hooks.openRule(node.id));
    const delBtn = bodyEl.querySelector('[data-act="delete-node"]');
    if (delBtn) delBtn.addEventListener('click', () => hooks.deleteNode(node.id));
    void ctx;
  }

  return { render, get currentId() { return currentId; }, setMode: (m) => { mode = m; } };
}

/** 生成附件表单（新建链接/资料） */
export function linkFormHTML(defaultKind = 'link') {
  return `
    <div class="form-row">
      <span class="form-label">类型</span>
      <div class="radio-list" data-role="kind">
        <label class="radio-item ${defaultKind === 'link' ? 'is-active' : ''}">
          <input type="radio" name="att-kind" value="link" ${defaultKind === 'link' ? 'checked' : ''} />
          <span><span class="ri-title">链接</span><span class="ri-desc">网页、文章、视频页面等，可直接打开</span></span>
        </label>
        <label class="radio-item ${defaultKind === 'ref' ? 'is-active' : ''}">
          <input type="radio" name="att-kind" value="ref" ${defaultKind === 'ref' ? 'checked' : ''} />
          <span><span class="ri-title">参考资料</span><span class="ri-desc">书籍、论文、文档，可记录出处与笔记</span></span>
        </label>
      </div>
    </div>
    <div class="form-row">
      <span class="form-label">标题</span>
      <input class="insp-input" data-role="att-title" placeholder="例如：设计系统参考" />
    </div>
    <div class="form-row">
      <span class="form-label">地址（URL）</span>
      <input class="insp-input" data-role="att-url" placeholder="https://" spellcheck="false" />
      <div class="form-hint">只接受 http/https 链接，避免脚本注入。</div>
    </div>
    <div class="form-row">
      <span class="form-label">备注</span>
      <textarea class="insp-textarea" data-role="att-note" style="min-height:70px" placeholder="为什么保存它？"></textarea>
    </div>`;
}

export function readLinkForm(root) {
  const kind = root.querySelector('input[name="att-kind"]:checked')?.value || 'link';
  const title = root.querySelector('[data-role="att-title"]').value.trim();
  const url = root.querySelector('[data-role="att-url"]').value.trim();
  const note = root.querySelector('[data-role="att-note"]').value.trim();
  return { kind, title, url, note };
}

export function newAttachmentId() {
  return uid('a');
}

export function previewSummary(node) {
  return plainSummary(node.note || '', 80);
}
