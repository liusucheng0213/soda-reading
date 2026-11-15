import { useRef, useState } from "react";
import { deleteTranslationCache } from "../lib/api.js";
import { MODEL_TASKS } from "./ModelTaskRoutes.jsx";

const EMPTY_USAGE = {
  attempts: 0,
  successes: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
  estimatedCny: 0,
};

export function ModelUsageSummary({ overview, onRefresh = async () => {}, onClearCache = deleteTranslationCache }) {
  const dialogRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cache = overview?.cache ?? {};
  const cost = overview?.costGuard ?? {};

  const confirmClear = async () => {
    setBusy(true);
    setError("");
    try {
      await onClearCache();
      dialogRef.current?.close();
      await onRefresh();
    } catch (cause) {
      setError(cause.message || "缓存清理失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="model-usage" aria-labelledby="model-usage-title">
      <div className="admin-panel-head">
        <div><h2 id="model-usage-title">任务与成本</h2><p>按今日（Asia/Shanghai）汇总。token 分为供应商报告与本地估算，费用只作保守预算参考。</p></div>
        <button type="button" onClick={() => dialogRef.current?.showModal()} disabled={busy}>清理翻译缓存</button>
      </div>
      <div className="translation-guard">
        <span><strong>{cache.memoryHits ?? 0}</strong> 内存命中</span>
        <span><strong>{cache.diskHits ?? 0}</strong> 磁盘命中</span>
        <span><strong>{cache.coalesced ?? 0}</strong> 重复请求合并</span>
        <span><strong>内存 {cache.memoryEntries ?? 0} · 磁盘 {cache.diskEntries ?? 0}</strong> 缓存条目</span>
        <span><strong>{cost.paidProvidersEnabled ? `${cost.dailyBudgetCny} 元上限` : "付费已关闭"}</strong> 已预留 {cost.reservedTodayCny ?? 0} 元</span>
      </div>
      <div className="model-usage-table">
        <table>
          <caption>今日任务用量</caption>
          <thead><tr><th scope="col">任务</th><th scope="col">结果</th><th scope="col">实际 token 输入 / 输出</th><th scope="col">估算 token 输入 / 输出</th><th scope="col">估算费用</th></tr></thead>
          <tbody>
            {MODEL_TASKS.map((task) => {
              const usage = overview?.tasks?.[task.id] ?? EMPTY_USAGE;
              return (
                <tr key={task.id}>
                  <th scope="row">{task.label}</th>
                  <td>{usage.successes} 成功 / {usage.failures} 失败</td>
                  <td>{usage.inputTokens} / {usage.outputTokens}</td>
                  <td>{usage.estimatedInputTokens} / {usage.estimatedOutputTokens}</td>
                  <td>{usage.estimatedCny} 元</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="inline-status error" role="alert">{error}</p>}
      <dialog ref={dialogRef} className="data-confirm model-cache-dialog" aria-labelledby="model-cache-confirm-title">
        <h3 id="model-cache-confirm-title">清理翻译缓存？</h3>
        <p>只删除本机翻译缓存。模型配置、密钥、用量记录、生词和阅读进度都会保留；下次需要翻译时可能重新调用模型。</p>
        <div className="data-confirm-actions">
          <form method="dialog"><button type="submit" autoFocus>取消</button></form>
          <button type="button" className="danger-button" onClick={confirmClear} disabled={busy}>{busy ? "清理中…" : "确认清理"}</button>
        </div>
      </dialog>
    </section>
  );
}
