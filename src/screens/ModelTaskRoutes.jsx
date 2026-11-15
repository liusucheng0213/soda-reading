export const MODEL_TASKS = [
  { id: "translation", label: "阅读翻译", help: "单词、短语和句子的语境翻译" },
  { id: "content_moderation", label: "内容审核", help: "供后续内容阶段使用，本阶段只保存路由" },
  { id: "daily_article", label: "每日 AI 文章", help: "导读、翻译与受证据约束的文章生成" },
];

export function routeIds(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function ModelTaskRoutes({ routes = {}, onChange }) {
  return (
    <fieldset className="model-task-routes">
      <legend>按任务调用模型</legend>
      <p>每个任务按自己的顺序尝试线路；密钥和付费总开关共用，不为单个任务绕过预算。</p>
      {MODEL_TASKS.map((task) => (
        <label className="provider-order-field model-task-route" key={task.id}>
          <span>{task.label}<small>{task.help}</small></span>
          <input
            aria-label={`${task.label}模型顺序`}
            value={(routes[task.id] || []).join(",")}
            onChange={(event) => onChange(task.id, routeIds(event.target.value))}
            placeholder="deepseek,zhipu"
          />
        </label>
      ))}
    </fieldset>
  );
}
