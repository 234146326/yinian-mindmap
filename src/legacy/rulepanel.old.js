/* 左侧「规则」层：按节点生效的模板渲染字段，填写结果直接写回节点。 */

import { escapeHtml } from './util.js';
import { icon, toast, openModal } from './ui.js';
import { readField, writeField, boardItems } from './rules.js';

export function createRulePanel({ el, hooks }) {
  let node = null;
  let resolved = null;
  let locked = false;
  let open = false;
  let customRules = [];

  el.innerHTML = `
    <div class="rule-head">
      <div class="rule-head-main">
        <span class="rule-badge">规则</span>
        <span class="rule-name" id="ruleName">自由导图</span>
      </div>
      <button class="icon-btn small" id="btnRuleCollapse" title="收起规则层 (⌘\\)" data-icon="chevronLeft"></button>
    </div>
    <div class="rule-meta" id="ruleMeta"></div>
    <div class="rule-picker">
      <select id="ruleSelect" aria-label="节点规则模板"></select>
      <button class="icon-btn small" id="btnRuleJson" title="查看 / 导入规则 JSON" data-icon="code"></button>
    </div>
    <div class="rule-lock" id="ruleLock" hidden>
      <span data-icon="lock"></span>
      <span>父节点必须放弃子节点后才可以编辑</span>
    </div>
    <div class="rule-body" id="ruleBody"></div>
    <div class="rule-foot">
      <button class="btn btn-ghost" id="btnRuleExport" data-icon="download">导出当前节点</button>
      <button class="btn btn-ghost" id="btnRuleImport" data-icon="upload">导入到当前节点</button>
    </div>
  `;

  const $ = (sel) => el.querySelector(sel);
  const body = $('#ruleBody');

  function setOpen(next) {
    open = next;
    el.classList.toggle('is-open', next);
    el.hidden = !next;
    document.body.classList.toggle('rule-open', next);
    if (next) render();
    if (hooks.onToggle) hooks.onToggle(next);
  }

  function fillPicker() {
    const select = $('#ruleSelect');
    const currentId = resolved ? resolved.template.id : '';
    const groups = new Map();
    for (const rule of hooks.rules()) {
      const key = rule.custom ? '自定义模板' : '内置模板';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rule);
    }
    select.innerHTML = [...groups.entries()]
      .map(
        ([label, list]) =>
          `<optgroup label="${escapeHtml(label)}">${list
            .map(
              (r) =>
                `<option value="${escapeHtml(r.id)}" ${r.id === currentId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`,
            )
            .join('')}</optgroup>`,
      )
      .join('');
    select.disabled = !node || locked;
  }

  function render() {
    if (!open || !node) return;
    customRules = hooks.customRules();
    const hasChildren = (node.children || []).length > 0;
    locked = hasChildren;
    $('#ruleName').textContent = resolved ? resolved.template.name : '规则';
    const meta = [];
    if (resolved && resolved.inherited) meta.push('继承自上级节点');
    else if (node.rule && node.rule.template) meta.push('本节点设定');
    else meta.push('默认模板');
    meta.push(`${resolved ? resolved.template.fields.length : 0} 个属性`);
    $('#ruleMeta').textContent = meta.join(' · ');
    $('#ruleLock').hidden = !locked;
    fillPicker();

    const template = resolved ? resolved.template : { fields: [] };
    body.innerHTML = template.fields
      .map((f) => fieldHTML(f, node, locked))
      .join('');
    hydrateMedia();
    body.querySelectorAll('[data-shots-add]').forEach((btn) => {
      btn.addEventListener('click', () => addShot());
    });
  }

  function fieldHTML(field, target, isLocked) {
    const dis = isLocked ? 'disabled' : '';
    const label = `<label class="field-label" for="rf-${field.key}">${escapeHtml(field.label)}</label>`;
    if (field.type === 'title') {
      return `<div class="rule-field" data-key="${field.key}">${label}
        <input id="rf-${field.key}" data-field="${field.key}" data-type="text" value="${escapeHtml(target.title || '')}"
          placeholder="${escapeHtml(field.placeholder || '')}" ${dis} /></div>`;
    }
    if (field.type === 'note' || field.type === 'textarea') {
      const rows = field.rows || (field.type === 'note' ? 3 : 4);
      return `<div class="rule-field" data-key="${field.key}">${label}
        <textarea id="rf-${field.key}" data-field="${field.key}" data-type="text" rows="${rows}"
          placeholder="${escapeHtml(field.placeholder || '')}" ${dis}>${escapeHtml(readField(target, field) || '')}</textarea></div>`;
    }
    if (field.type === 'text') {
      return `<div class="rule-field" data-key="${field.key}">${label}
        <input id="rf-${field.key}" data-field="${field.key}" data-type="text" value="${escapeHtml(readField(target, field) || '')}"
          placeholder="${escapeHtml(field.placeholder || '')}" ${dis} /></div>`;
    }
    if (field.type === 'image-url' || field.type === 'video-url') {
      const value = readField(target, field) || '';
      const preview = value
        ? field.type === 'image-url'
          ? `<img class="rule-media-preview" src="${escapeHtml(value)}" alt="" loading="lazy" />`
          : `<div class="rule-media-note">${icon('video')} 视频链接</div>`
        : '';
      return `<div class="rule-field" data-key="${field.key}">${label}
        <input id="rf-${field.key}" data-field="${field.key}" data-type="text" value="${escapeHtml(value)}"
          placeholder="${escapeHtml(field.placeholder || '')}" ${dis} />
        ${preview}</div>`;
    }
    if (field.type === 'shots') return shotsHTML(field, target, isLocked);
    if (field.type === 'board') return boardHTML(field, target);
    if (field.type === 'attachments') {
      const list = target.attachments || [];
      const rows = list.length
        ? list
            .map(
              (a) => `<li class="rule-att" data-att="${escapeHtml(a.id)}">
                  <span class="ra-kind">${escapeHtml(kindLabel(a.kind))}</span>
                  <span class="ra-title">${escapeHtml(a.title || a.url || a.name || '未命名')}</span>
                </li>`,
            )
            .join('')
        : '<li class="rule-empty">还没有附件</li>';
      return `<div class="rule-field" data-key="${field.key}">${label}
        <ul class="rule-atts">${rows}</ul>
        ${isLocked ? '' : `<button class="link-btn" data-att-add>＋ 添加附件</button>`}</div>`;
    }
    return '';
  }

  function shotsHTML(field, target, isLocked) {
    const label = `<label class="field-label">${escapeHtml(field.label)}</label>`;
    const shots = readField(target, field);
    const rows = shots.length
      ? shots
          .map(
            (s, i) => `<li class="shot" data-shot="${escapeHtml(s.id)}">
        <div class="shot-thumb" data-media="${escapeHtml(s.mediaId || '')}">
          ${s.mediaId ? '<span class="thumb-loading">…</span>' : '<span class="thumb-empty">无图</span>'}
        </div>
        <div class="shot-fields">
          <input data-shot-name value="${escapeHtml(s.name || '')}" placeholder="镜头 ${i + 1}" ${isLocked ? 'disabled' : ''} />
          <textarea data-shot-desc rows="2" placeholder="画面说明" ${isLocked ? 'disabled' : ''}>${escapeHtml(s.desc || '')}</textarea>
          <div class="shot-actions">
            ${isLocked ? '' : `<button class="link-btn" data-shot-pick>${s.mediaId ? '换图' : '选图'}</button>`}
            ${s.mediaId && !isLocked ? '<button class="link-btn" data-shot-clear>移除图</button>' : ''}
            ${isLocked ? '' : '<button class="link-btn danger" data-shot-del>删除镜头</button>'}
          </div>
        </div>
      </li>`,
          )
          .join('')
      : '<li class="rule-empty">还没有分镜，点下面按钮开始</li>';
    return `<div class="rule-field" data-key="${field.key}">${label}
      <ul class="shots">${rows}</ul>
      ${isLocked ? '' : '<button class="btn btn-ghost btn-block" data-shots-add>＋ 添加分镜</button>'}</div>`;
  }

  function boardHTML(field, target) {
    const label = `<label class="field-label">${escapeHtml(field.label)}</label>`;
    const items = boardItems(target);
    const cells = items.length
      ? items
          .map(
            (s) => `<figure class="board-cell" data-media="${escapeHtml(s.mediaId)}">
              <span class="thumb-loading">…</span>
              <figcaption>${escapeHtml(s.name || '分镜')}</figcaption></figure>`,
          )
          .join('')
      : '<p class="rule-empty">给分镜加上图片后，这里会自动汇总成故事板</p>';
    return `<div class="rule-field" data-key="${field.key}">${label}
      <div class="board">${cells}</div></div>`;
  }

  async function hydrateMedia() {
    const holders = body.querySelectorAll('[data-media]');
    for (const holder of holders) {
      const id = holder.dataset.media;
      if (!id) continue;
      const url = await hooks.mediaUrl(id);
      if (!url) {
        holder.innerHTML = '<span class="thumb-empty">图片已丢失</span>';
        continue;
      }
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      holder.querySelector('.thumb-loading')?.remove();
      if (holder.classList.contains('board-cell')) {
        holder.insertBefore(img, holder.firstChild);
      } else {
        holder.innerHTML = '';
        holder.appendChild(img);
        holder.addEventListener('click', () => hooks.openLightbox(img.src, holder.dataset.caption || ''), {
          once: true,
        });
      }
    }
  }

  function addShot() {
    if (!node || locked) return;
    const field = resolved.template.fields.find((f) => f.type === 'shots');
    if (!field) return;
    const shots = readField(node, field).slice();
    shots.push({ id: `s${Date.now().toString(36)}`, name: `镜头 ${shots.length + 1}`, desc: '', mediaId: '' });
    hooks.updateData(node.id, { [field.key]: shots });
  }

  /* ---------------- 事件 ---------------- */

  body.addEventListener('input', (e) => {
    const fieldKey = e.target.dataset.field;
    if (!fieldKey || locked) return;
    const field = resolved.template.fields.find((f) => f.key === fieldKey);
    if (!field || field.type === 'shots') return;
    hooks.updateField(node.id, field, e.target.value, { silent: true });
  });

  body.addEventListener('change', (e) => {
    const fieldKey = e.target.dataset.field;
    if (!fieldKey || locked) return;
    const field = resolved.template.fields.find((f) => f.key === fieldKey);
    if (!field) return;
    hooks.updateField(node.id, field, e.target.value, { silent: true, commit: true });
  });

  body.addEventListener('click', async (e) => {
    const shotEl = e.target.closest('.shot');
    const shotId = shotEl ? shotEl.dataset.shot : null;
    const shotsField = resolved.template.fields.find((f) => f.type === 'shots');
    const getShots = () => (shotsField ? readField(node, shotsField).map((s) => ({ ...s })) : []);
    const setShots = (list) => hooks.updateData(node.id, { [shotsField.key]: list });

    if (e.target.closest('[data-att-add]')) {
      hooks.addAttachment(node.id);
      return;
    }
    if (!shotId || locked || !shotsField) return;
    if (e.target.closest('[data-shot-pick]')) {
      const media = await hooks.pickMedia();
      if (!media) return;
      const list = getShots();
      const target = list.find((s) => s.id === shotId);
      if (!target) return;
      target.mediaId = media.id;
      target.mime = media.mime;
      setShots(list);
    } else if (e.target.closest('[data-shot-clear]')) {
      const list = getShots();
      const target = list.find((s) => s.id === shotId);
      if (target) {
        target.mediaId = '';
        setShots(list);
      }
    } else if (e.target.closest('[data-shot-del]')) {
      setShots(getShots().filter((s) => s.id !== shotId));
    }
  });

  body.addEventListener('input', (e) => {
    if (!e.target.matches('[data-shot-name], [data-shot-desc]') || locked) return;
    const shotId = e.target.closest('.shot').dataset.shot;
    const shotsField = resolved.template.fields.find((f) => f.type === 'shots');
    if (!shotsField) return;
    const list = readField(node, shotsField).map((s) => ({ ...s }));
    const target = list.find((s) => s.id === shotId);
    if (!target) return;
    if (e.target.matches('[data-shot-name]')) target.name = e.target.value;
    else target.desc = e.target.value;
    hooks.updateData(node.id, { [shotsField.key]: list }, { silent: true });
  });

  $('#ruleSelect').addEventListener('change', (e) => {
    if (!node) return;
    hooks.setTemplate(node.id, e.target.value);
  });

  $('#btnRuleCollapse').addEventListener('click', () => setOpen(false));
  $('#btnRuleExport').addEventListener('click', () => {
    if (node) hooks.openNodeJson(node.id, 'export');
  });
  $('#btnRuleImport').addEventListener('click', () => {
    if (node) hooks.openNodeJson(node.id, 'import');
  });
  $('#btnRuleJson').addEventListener('click', () => {
    if (!resolved) return;
    const text = JSON.stringify(resolved.template, null, 2);
    const { modal, close } = openModal({
      title: '规则 JSON',
      wide: true,
      body: `<p class="form-hint">规则模板就是一份 JSON：<code>id / name / fields[]</code>。复制后可以存成文件，也可以修改后再导入成为自定义模板。</p>
        <textarea class="json-area" id="ruleJsonText" rows="16">${escapeHtml(text)}</textarea>`,
      footer: `<button class="btn" data-close>关闭</button>
        <button class="btn" data-copy>复制</button>
        <button class="btn btn-primary" data-import>导入为自定义模板</button>`,
    });
    modal.querySelector('[data-copy]').addEventListener('click', () => {
      hooks.copyText(modal.querySelector('#ruleJsonText').value, '规则 JSON 已复制');
    });
    modal.querySelector('[data-import]').addEventListener('click', () => {
      const raw = modal.querySelector('#ruleJsonText').value;
      try {
        hooks.addCustomRule(raw);
        close();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });
  });

  return {
    setOpen,
    isOpen: () => open,
    toggle: () => setOpen(!open),
    setNode(nextNode, nextResolved) {
      node = nextNode;
      resolved = nextResolved;
      if (open) render();
      document.body.classList.toggle('rule-empty', !node);
    },
    render: () => render(),
  };
}

function kindLabel(kind) {
  return { image: '图片', video: '视频', link: '链接', ref: '资料', file: '文件' }[kind] || '附件';
}
