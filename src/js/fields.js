/* 规则字段渲染器：把一份规则模板中的字段渲染成可填写控件。
 * 详情层用它呈现「父节点要求的属性」，规则层只负责定义规则本身。
 */

import { escapeHtml } from './util.js';
import { readField, boardItems, contentFields, episodeField } from './rules.js';

export function createFieldEditor({ container, hooks }) {
  let node = null;
  let fields = [];
  let locked = false;

  function render(nextNode, template, opts = {}) {
    node = nextNode;
    locked = !!opts.locked;
    fields = contentFields(template);
    if (!node || !fields.length) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML = `
      <div class="insp-section">
        <div class="insp-label">
          <span>规则属性</span>
          <span class="rule-chip">${escapeHtml(template.name)}</span>
        </div>
        <div class="field-stack">${fields.map(fieldHTML).join('')}</div>
      </div>`;
    hydrateMedia();
  }

  /** 子节点区：规则里声明了「集数」时，数量与真实子节点数保持一致，
   *  填写更大的数字只会补齐差额，填小不会删除已有节点。 */
  function renderEpisodes(host, nextNode, template) {
    if (!host) return;
    const field = episodeField(template);
    if (!field || !nextNode) {
      host.innerHTML = '';
      return;
    }
    node = nextNode;
    host.hidden = false;
    const count = (nextNode.children || []).length;
    host.innerHTML = `
      <div class="insp-section" data-role="episodes">
        <div class="insp-label">
          <span>子节点</span>
          <span class="rule-chip">${escapeHtml(field.label)} · ${escapeHtml(template.name)}</span>
        </div>
        <div class="episodes-row">
          <input type="number" min="0" max="999" step="1" inputmode="numeric"
            data-episodes-input value="${count}" aria-label="${escapeHtml(field.label)}" />
          <span class="episodes-unit">集</span>
          <button class="btn btn-sm btn-primary" data-episodes-gen>一键生成</button>
        </div>
        <p class="rule-hint" data-episodes-hint>当前实际 ${count} 个子节点 · 填更大的数字只补齐差额，填更小不会删除</p>
      </div>`;

    const input = host.querySelector('[data-episodes-input]');
    const submit = () => {
      const want = Math.floor(Number(input.value) || 0);
      hooks.setEpisodes(node.id, field, want);
    };
    host.querySelector('[data-episodes-gen]').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  }

  function fieldHTML(field) {
    const dis = locked ? 'disabled' : '';
    const label = `<label class="field-label">${escapeHtml(field.label)}</label>`;
    const value = readField(node, field);

    if (field.type === 'textarea' || field.type === 'text') {
      const rows = field.rows || 4;
      if (field.type === 'text') {
        return `<div class="rule-field" data-key="${field.key}">${label}
          <input data-field="${field.key}" value="${escapeHtml(value || '')}"
            placeholder="${escapeHtml(field.placeholder || '')}" ${dis} /></div>`;
      }
      return `<div class="rule-field" data-key="${field.key}">${label}
        <textarea data-field="${field.key}" rows="${rows}" placeholder="${escapeHtml(field.placeholder || '')}" ${dis}>${escapeHtml(
          value || '',
        )}</textarea></div>`;
    }

    if (field.type === 'image-url') {
      return `<div class="rule-field" data-key="${field.key}">${label}
        <input data-field="${field.key}" value="${escapeHtml(value || '')}"
          placeholder="${escapeHtml(field.placeholder || 'https://…')}" ${dis} />
        ${value ? `<img class="rule-media-preview" src="${escapeHtml(value)}" alt="" loading="lazy" />` : ''}</div>`;
    }

    if (field.type === 'video-url') {
      return `<div class="rule-field" data-key="${field.key}">${label}
        <input data-field="${field.key}" value="${escapeHtml(value || '')}"
          placeholder="${escapeHtml(field.placeholder || 'https://…')}" ${dis} />
        ${
          value
            ? `<video class="rule-media-preview" src="${escapeHtml(value)}" controls preload="metadata"></video>`
            : ''
        }</div>`;
    }

    if (field.type === 'shots') {
      const shots = Array.isArray(value) ? value : [];
      const rows = shots.length
        ? shots
            .map(
              (s, i) => `<li class="shot" data-shot="${escapeHtml(s.id)}">
          <div class="shot-thumb" data-media="${escapeHtml(s.mediaId || '')}">
            ${s.mediaId ? '<span class="thumb-loading">…</span>' : '<span class="thumb-empty">无图</span>'}
          </div>
          <div class="shot-fields">
            <input data-shot-name value="${escapeHtml(s.name || '')}" placeholder="镜头 ${i + 1}" ${dis} />
            <textarea data-shot-desc rows="2" placeholder="画面说明" ${dis}>${escapeHtml(s.desc || '')}</textarea>
            <div class="shot-actions">
              ${locked ? '' : `<button class="link-btn" data-shot-pick>${s.mediaId ? '换图' : '选图'}</button>`}
              ${s.mediaId && !locked ? '<button class="link-btn" data-shot-clear>移除图</button>' : ''}
              ${locked ? '' : '<button class="link-btn danger" data-shot-del>删除</button>'}
            </div>
          </div>
        </li>`,
            )
            .join('')
        : '<li class="rule-empty">还没有分镜</li>';
      return `<div class="rule-field" data-key="${field.key}">${label}
        <ul class="shots">${rows}</ul>
        ${locked ? '' : '<button class="btn btn-sm btn-block" data-shots-add>＋ 添加分镜</button>'}</div>`;
    }

    if (field.type === 'board') {
      const items = boardItems(node);
      const cells = items.length
        ? items
            .map(
              (s) => `<figure class="board-cell" data-media="${escapeHtml(s.mediaId)}">
            <span class="thumb-loading">…</span>
            <figcaption>${escapeHtml(s.name || '分镜')}</figcaption></figure>`,
            )
            .join('')
        : '<p class="rule-empty">给分镜加上图片后，这里会自动汇总成故事板</p>';
      return `<div class="rule-field" data-key="${field.key}">${label}<div class="board">${cells}</div></div>`;
    }

    if (field.type === 'attachments') {
      const list = node.attachments || [];
      const rows = list.length
        ? list
            .map(
              (a) => `<li class="rule-att">
            <span class="ra-kind">${escapeHtml(kindLabel(a.kind))}</span>
            <span class="ra-title">${escapeHtml(a.title || a.url || a.name || '未命名')}</span></li>`,
            )
            .join('')
        : '<li class="rule-empty">还没有附件</li>';
      return `<div class="rule-field" data-key="${field.key}">${label}
        <ul class="rule-atts">${rows}</ul>
        ${locked ? '' : '<button class="link-btn" data-att-add>＋ 添加链接 / 资料</button>'}</div>`;
    }

    return '';
  }

  async function hydrateMedia() {
    for (const holder of container.querySelectorAll('[data-media]')) {
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
        holder.addEventListener('click', () => hooks.openLightbox(url, holder.dataset.caption || ''));
      }
    }
  }

  const shotsField = () => fields.find((f) => f.type === 'shots');
  const getShots = () => {
    const f = shotsField();
    return f ? (Array.isArray(node.data && node.data[f.key]) ? node.data[f.key].map((s) => ({ ...s })) : []) : [];
  };
  const setShots = (list) => {
    const f = shotsField();
    if (f) hooks.updateData(node.id, { [f.key]: list });
  };

  container.addEventListener('input', (e) => {
    if (locked) return;
    const key = e.target.dataset.field;
    if (key) {
      const field = fields.find((f) => f.key === key);
      if (field) hooks.updateField(node.id, field, e.target.value);
      return;
    }
    if (e.target.matches('[data-shot-name], [data-shot-desc]')) {
      const shotId = e.target.closest('.shot').dataset.shot;
      const list = getShots();
      const target = list.find((s) => s.id === shotId);
      if (!target) return;
      if (e.target.matches('[data-shot-name]')) target.name = e.target.value;
      else target.desc = e.target.value;
      setShots(list);
    }
  });

  container.addEventListener('click', async (e) => {
    if (e.target.closest('[data-att-add]')) {
      hooks.addAttachment(node.id);
      return;
    }
    if (e.target.closest('[data-shots-add]')) {
      if (locked) return;
      const list = getShots();
      list.push({ id: `s${Date.now().toString(36)}`, name: `镜头 ${list.length + 1}`, desc: '', mediaId: '' });
      setShots(list);
      return;
    }
    const shotEl = e.target.closest('.shot');
    if (!shotEl || locked) return;
    const shotId = shotEl.dataset.shot;
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

  return { render, renderEpisodes };
}

function kindLabel(kind) {
  return { image: '图片', video: '视频', link: '链接', ref: '资料', file: '文件' }[kind] || '附件';
}
