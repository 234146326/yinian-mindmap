/* 节点规则：用 JSON 定义「当前节点及其下级要收集哪些属性」。
 *
 * 一个模板 = 一组字段定义。节点本身可以绑定模板（node.rule.template），
 * 没有绑定的节点沿祖先继承；都没有则使用「自由导图」。
 */

export const FIELD_TYPES = [
  'title',
  'note',
  'text',
  'textarea',
  'shots',
  'board',
  'image-url',
  'video-url',
  'attachments',
  // 集数：不是节点内容，而是「这个节点有多少个子节点」的结构控制
  'episodes',
];

export const BUILTIN_RULES = [
  {
    id: 'free',
    name: '自由导图',
    hint: '只有名称与描述，创建时最轻量',
    fields: [
      { key: 'name', label: '名称', type: 'title', placeholder: '这个节点叫什么' },
      { key: 'desc', label: '描述', type: 'note', placeholder: '一两句话说明它' },
    ],
  },
  {
    id: 'anime',
    name: '动漫模板',
    hint: '名称、描述、梗概、分镜列表（带图）、故事板、图片/视频链接、附件',
    fields: [
      { key: 'name', label: '名称', type: 'title', placeholder: '作品 / 章节 / 角色名' },
      { key: 'desc', label: '描述', type: 'note', placeholder: '一句话概括' },
      { key: 'episodes', label: '集数', type: 'episodes' },
      { key: 'synopsis', label: '梗概', type: 'textarea', rows: 5, placeholder: '故事梗概、设定说明…' },
      { key: 'shots', label: '分镜列表', type: 'shots' },
      { key: 'board', label: '故事板', type: 'board' },
      { key: 'imageUrl', label: '图片 URL', type: 'image-url', placeholder: 'https://…/cover.jpg' },
      { key: 'videoUrl', label: '视频 URL', type: 'video-url', placeholder: 'https://…/clip.mp4' },
      { key: 'files', label: '附件', type: 'attachments' },
    ],
  },
];

export const DEFAULT_RULE_ID = 'free';

export function allRules(custom = []) {
  const list = BUILTIN_RULES.slice();
  for (const item of custom || []) {
    if (item && item.id && !list.some((r) => r.id === item.id)) list.push(item);
  }
  return list;
}

export function findRule(id, custom = []) {
  return allRules(custom).find((r) => r.id === id) || null;
}

/** 从根到目标节点的路径（找不到返回空数组） */
export function pathOf(root, id) {
  const path = [];
  const dfs = (node) => {
    path.push(node);
    if (node.id === id) return true;
    for (const child of node.children || []) {
      if (dfs(child)) return true;
    }
    path.pop();
    return false;
  };
  return root && dfs(root) ? path : [];
}

/**
 * 节点「自身内容」需要满足的规则：由父节点决定（唯一路径）。
 * 没有父级规则时，若该节点是脱离出来的根，则沿用脱离时继承的规则；
 * 都不是则回落到默认模板（自由导图）。
 */
export function resolveContentRule(root, nodeId, custom = []) {
  const path = pathOf(root, nodeId);
  const self = path[path.length - 1] || null;
  for (let i = path.length - 2; i >= 0; i -= 1) {
    const node = path[i];
    if (node.rule && node.rule.template) {
      const template = findRule(node.rule.template, custom);
      if (template) {
        return { template, sourceId: node.id, sourceTitle: node.title, inherited: true, self };
      }
    }
  }
  const carried = self && self.ruleInherited && self.ruleInherited.template;
  if (carried) {
    const template = findRule(carried, custom);
    if (template) {
      return {
        template,
        sourceId: (self.ruleInherited && self.ruleInherited.from) || null,
        sourceTitle: null,
        inherited: true,
        detached: true,
        self,
      };
    }
  }
  return {
    template: findRule(DEFAULT_RULE_ID, custom) || BUILTIN_RULES[0],
    sourceId: null,
    inherited: false,
    self,
  };
}

/** 节点向下的规则：约束它自己的子节点，与它自身内容无关。 */
export function resolveDownRule(node, custom = []) {
  if (node && node.rule && node.rule.template) {
    const template = findRule(node.rule.template, custom);
    if (template) return { template, own: true };
  }
  return { template: findRule(DEFAULT_RULE_ID, custom) || BUILTIN_RULES[0], own: false };
}

/** 兼容旧名 */
export const resolveRule = resolveContentRule;

/** 只保留「本节点自身内容」需要的字段（名称/描述由详情层的基础控件负责；
 *  episodes 描述的是子节点数量，单独在详情层的「子节点」区渲染） */
export function contentFields(template) {
  if (!template) return [];
  return template.fields.filter((f) => f.type !== 'title' && f.type !== 'note' && f.type !== 'episodes');
}

/** 把「集数」这类字段的值与真实子节点数对齐（派生镜像，不产生历史） */
export function syncEpisodeField(node, custom = []) {
  if (!node) return false;
  const field = episodeField(resolveDownRule(node, custom).template);
  if (!field) return false;
  const count = (node.children || []).length;
  if (!node.data) node.data = {};
  if (node.data[field.key] === count) return false;
  node.data[field.key] = count;
  return true;
}

/** 规则里是否声明了「集数」这类子节点数量字段 */
export function episodeField(template) {
  if (!template) return null;
  return template.fields.find((f) => f.type === 'episodes') || null;
}

/* ---------------- 字段读写 ---------------- */

export function readField(node, field) {
  if (!node) return '';
  if (field.type === 'title') return node.title || '';
  if (field.type === 'note') return node.note || '';
  if (field.type === 'shots') {
    const list = node.data && node.data[field.key];
    return Array.isArray(list) ? list : [];
  }
  if (field.type === 'attachments') return node.attachments || [];
  if (field.type === 'episodes') return (node.children || []).length;
  const value = node.data ? node.data[field.key] : '';
  return value == null ? '' : value;
}

export function writeField(node, field, value) {
  if (!node) return;
  if (field.type === 'title') {
    node.title = String(value || '').slice(0, 500);
    return;
  }
  if (field.type === 'note') {
    node.note = String(value || '');
    return;
  }
  if (!node.data) node.data = {};
  // 集数永远等于真实子节点数，写入时只记录目标，由 add/remove 负责真实结构
  if (field.type === 'episodes') {
    node.data[field.key] = (node.children || []).length;
    return;
  }
  node.data[field.key] = value;
}

/** 故事板：从分镜里汇总所有已上传图片 */
export function boardItems(node) {
  const shots = (node && node.data && node.data.shots) || [];
  return shots.filter((s) => s && s.mediaId);
}

/* ---------------- 模板 JSON 校验 ---------------- */

export class RuleError extends Error {}

export function normalizeRuleTemplate(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new RuleError('不是合法的 JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new RuleError('模板必须是一个对象');
  const id = String(obj.id || '').trim();
  const name = String(obj.name || '').trim();
  if (!id) throw new RuleError('缺少 id');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new RuleError('id 只能包含字母、数字、下划线和短横线');
  if (!name) throw new RuleError('缺少 name');
  if (!Array.isArray(obj.fields) || !obj.fields.length) throw new RuleError('fields 必须是非空数组');
  const seen = new Set();
  let seenEpisodes = false;
  let titleCount = 0;
  let noteCount = 0;
  const fields = obj.fields.map((f, i) => {
    if (!f || typeof f !== 'object') throw new RuleError(`第 ${i + 1} 个字段不是对象`);
    const key = String(f.key || '').trim();
    const label = String(f.label || '').trim();
    const type = String(f.type || 'text').trim();
    if (!key) throw new RuleError(`第 ${i + 1} 个字段缺少 key`);
    if (seen.has(key)) throw new RuleError(`字段 key 重复：${key}`);
    seen.add(key);
    if (!label) throw new RuleError(`字段 ${key} 缺少 label`);
    if (!FIELD_TYPES.includes(type)) throw new RuleError(`字段 ${key} 的类型 ${type} 不支持`);
    if (type === 'episodes' && seenEpisodes) throw new RuleError('episodes 类型字段只能出现一次');
    const out = { key, label, type };
    if (f.placeholder) out.placeholder = String(f.placeholder);
    if (f.rows) out.rows = Math.min(20, Math.max(2, Number(f.rows) || 4));
    if (type === 'episodes') seenEpisodes = true;
    if (type === 'title') {
      titleCount += 1;
      if (titleCount > 1) throw new RuleError('title 类型字段只能出现一次');
    }
    if (type === 'note') {
      noteCount += 1;
      if (noteCount > 1) throw new RuleError('note 类型字段只能出现一次');
    }
    return out;
  });
  return {
    id,
    name,
    hint: obj.hint ? String(obj.hint) : '',
    fields,
    custom: true,
  };
}

export const RULE_EXAMPLE = {
  id: 'novel',
  name: '小说模板',
  hint: '自定义示例：人物、章节、伏笔',
  fields: [
    { key: 'name', label: '名称', type: 'title' },
    { key: 'desc', label: '描述', type: 'note' },
    { key: 'characters', label: '人物', type: 'textarea', rows: 4 },
    { key: 'beats', label: '情节节拍', type: 'textarea', rows: 4 },
    { key: 'refs', label: '参考链接', type: 'attachments' },
  ],
};
