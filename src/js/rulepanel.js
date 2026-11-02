/* 左侧「规则」层：定义当前节点向下的结构约束（约束的是它的子节点，不是它自己）。 */

import { escapeHtml } from './util.js';
import { toast, openModal } from './ui.js';

export function createRulePanel({ el, hooks }) {
  let node = null;
  let down = null; // 当前节点的向下规则
  let content = null; // 当前节点自身内容所遵循的规则（由父节点决定）
  let locked = false;
  let open = false;
  let jsonOpen = false;

  el.innerHTML = `
    <div class="rule-head">
      <div class="rule-head-main">
        <span class="rule-badge">规则</span>
        <span class="rule-name" id="ruleName">自由导图</span>
      </div>
      <button class="icon-btn small" id="btnRuleCollapse" title="收起规则层" data-icon="chevronLeft"></button>
    </div>
    <div class="rule-meta" id="ruleMeta"></div>
    <div class="rule-picker">
      <select id="ruleSelect" aria-label="向下规则模板"></select>
      <button class="icon-btn small" id="btnRuleJson" title="展开 / 收起规则 JSON" data-icon="code"></button>
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
    el.hidden = !next;
    el.classList.toggle('is-open', next);
    document.body.classList.toggle('rule-open', next);
    if (next) render();
    if (hooks.onToggle) hooks.onToggle(next);
  }

  function fillPicker() {
    const select = $('#ruleSelect');
    const currentId = down ? down.template.id : '';
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
    select.disabled = !node;
  }

  function render() {
    if (!open || !node) return;
    locked = (node.children || []).length > 0;
    const lockText = el.querySelector('#ruleLock span:last-child');
    if (lockText) {
      lockText.textContent = locked
        ? `修改规则会影响全部 ${(node.children || []).length} 个子节点，确认后才会生效`
        : '';
    }

    const childCount = (node.children || []).length;
    $('#ruleName').textContent = down ? down.template.name : '自由导图';
    const meta = [];
    meta.push(down && down.own ? '本节点设定' : '未设定 · 使用默认');
    meta.push(childCount ? `约束 ${childCount} 个子节点` : '约束未来的子节点');
    if (content && content.sourceTitle) meta.push(`自身遵循「${content.sourceTitle}」`);
    else if (content && content.detached) meta.push('自身沿用脱离时继承的规则');
    else meta.push('自身遵循默认模板');
    $('#ruleMeta').textContent = meta.join(' · ');
    $('#ruleLock').hidden = !locked;
    fillPicker();

    const template = down ? down.template : null;
    const fields = template ? template.fields : [];
    const attrCount = fields.filter((f) => f.type !== 'episodes').length;
    const hasEpisodes = fields.some((f) => f.type === 'episodes');
    body.innerHTML = `
      <p class="rule-note">
        规则属于这个节点，但约束的是它<b>下面的子节点</b>：子节点必须按这些属性填写。
        子节点还可以继续定义自己的规则，再往下约束。
      </p>
      <div class="rule-fieldset">
        <div class="field-label">子节点必须具备的属性 <em>${attrCount} 个</em></div>
        ${hasEpisodes ? '<p class="rule-note tight">另有「集数」：它不写进子节点，而是决定这个节点生成多少个子节点。</p>' : ''}
        <ul class="rule-chips">
          ${fields.map(chipHTML).join('')}
        </ul>
      </div>
      ${
        content
          ? `<div class="rule-fieldset">
              <div class="field-label">本节点自身内容</div>
              <p class="rule-note">由${
                content.sourceTitle ? `父节点「${escapeHtml(content.sourceTitle)}」` : '默认模板'
              }决定，${content.template.fields.length} 个属性，在右侧详情层填写。</p>
            </div>`
          : ''
      }
      <details class="rule-json" ${jsonOpen ? 'open' : ''}>
        <summary><span data-icon="code"></span>规则 JSON（可直接改，改完点应用）</summary>
        <textarea class="json-area" id="ruleJsonInline" rows="14" spellcheck="false">${escapeHtml(
          templateJSON(template),
        )}</textarea>
        <div class="rule-json-actions">
          <button class="btn btn-sm" data-json-reset>还原</button>
          <button class="btn btn-sm" data-json-copy>复制</button>
          <button class="btn btn-sm btn-primary" data-json-apply>应用为当前节点的规则</button>
        </div>
      </details>
      ${locked ? '<p class="rule-note warn">子节点已经按当前规则填过内容，切换前会再确认一次，不会静默改动。</p>' : ''}
    `;
    body.classList.toggle('json-open', jsonOpen);
  }

  function chipHTML(f) {
    return `<li class="rule-chip-item"><span>${escapeHtml(f.label)}</span><em>${escapeHtml(
      typeLabel(f.type),
    )}</em><code>${escapeHtml(f.key)}</code></li>`;
  }

  function typeLabel(type) {
    return (
      {
        title: '名称',
        note: '描述',
        text: '单行文本',
        textarea: '多行文本',
        shots: '分镜列表',
        board: '故事板',
        'image-url': '图片 URL',
        'video-url': '视频 URL',
        attachments: '附件',
        episodes: '子节点数量',
      }[type] || type
    );
  }

  /** 节点当前规则的 JSON：只保留可交换的字段，去掉运行期标记 */
  function templateJSON(template) {
    if (!template) return '{}';
    return JSON.stringify(
      {
        id: template.id,
        name: template.name,
        hint: template.hint || '',
        fields: template.fields.map((f) => ({ ...f })),
      },
      null,
      2,
    );
  }

  $('#ruleSelect').addEventListener('change', (e) => {
    if (!node) return;
    hooks.setTemplate(node.id, e.target.value);
  });

  $('#btnRuleCollapse').addEventListener('click', () => setOpen(false));
  $('#btnRuleExport').addEventListener('click', () => node && hooks.openNodeJson(node.id, 'export'));
  $('#btnRuleImport').addEventListener('click', () => node && hooks.openNodeJson(node.id, 'import'));

  // JSON 区：展开 / 收起、还原、复制、应用
  $('#btnRuleJson').addEventListener('click', () => {
    jsonOpen = !jsonOpen;
    render();
  });

  body.addEventListener('toggle', () => {
    const d = body.querySelector('.rule-json');
    if (d) jsonOpen = d.open;
  }, true);

  body.addEventListener('click', (e) => {
    const area = body.querySelector('#ruleJsonInline');
    if (!area || !down) return;
    if (e.target.closest('[data-json-reset]')) {
      area.value = templateJSON(down.template);
      toast('已还原为当前节点正在使用的规则');
      return;
    }
    if (e.target.closest('[data-json-copy]')) {
      hooks.copyText(area.value, '规则 JSON 已复制');
      return;
    }
    if (e.target.closest('[data-json-apply]')) {
      Promise.resolve()
        .then(() => hooks.applyRuleJson(node.id, area.value))
        .catch((err) => toast(`规则无法应用：${err.message}`, { type: 'error' }));
    }
  });

  return {
    setOpen,
    isOpen: () => open,
    toggle: () => setOpen(!open),
    setNode(nextNode, nextDown, nextContent) {
      node = nextNode;
      down = nextDown;
      content = nextContent;
      if (open) render();
    },
    render: () => render(),
  };
}
