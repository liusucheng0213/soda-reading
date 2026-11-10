import { useRef, useState } from "react";
import { exportLocalData, parseBackup, restoreErrorMessage, restoreLocalData } from "../lib/backup.js";

export function DataManagement({ documents, vocabularyCount, highlightCount, onDeleteDocument, onClearData }) {
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const exportBackup = async () => {
    setBusy(true);
    setError("");
    try {
      const backup = await exportLocalData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `soda-reading-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("备份已导出");
    } catch {
      setError("导出失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const chooseBackup = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const { backup, summary } = parseBackup(await file.text());
      setPending({ kind: "restore", backup, summary, title: "恢复这个备份？" });
      dialogRef.current?.showModal();
    } catch (cause) {
      setError(cause.message || "无法读取这个备份");
    } finally {
      event.target.value = "";
    }
  };

  const confirm = (action) => {
    setError("");
    setPending(action);
    dialogRef.current?.showModal();
  };

  const execute = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      if (pending.kind === "restore") {
        await restoreLocalData(pending.backup);
        window.location.reload();
        return;
      }
      if (pending.kind === "document") await onDeleteDocument(pending.document.id);
      else if (pending.kind === "clear") await onClearData(pending.bucket);
      setStatus(pending.kind === "document" ? "书籍已删除" : "已清空");
      dialogRef.current?.close();
      setPending(null);
    } catch (cause) {
      setError(pending.kind === "restore" ? restoreErrorMessage(cause) : "操作未完成，请检查数据后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-management" aria-labelledby="data-management-title">
      <h3 className="settings-label" id="data-management-title">数据管理</h3>
      <p className="data-summary">{documents.length} 本导入书 · {vocabularyCount} 个生词 · {highlightCount} 条划线</p>
      <p className="data-help">备份包含书籍和个人学习记录，不包含模型密钥或在线内容数据库。</p>
      <div className="data-actions">
        <button type="button" onClick={exportBackup} disabled={busy}>导出完整备份</button>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>选择备份并恢复</button>
        <input ref={inputRef} hidden type="file" accept=".json,application/json" onChange={chooseBackup} aria-label="选择苏打阅读备份" />
      </div>
      {documents.length > 0 && (
        <ul className="data-document-list">
          {documents.map((document) => (
            <li key={document.id}>
              <span>{document.title}</span>
              <button type="button" onClick={() => confirm({ kind: "document", document, title: `删除《${document.title}》？` })}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <div className="data-clear-actions">
        <button type="button" onClick={() => confirm({ kind: "clear", bucket: "vocabulary", title: "清空全部生词？" })} disabled={!vocabularyCount}>清空生词</button>
        <button type="button" onClick={() => confirm({ kind: "clear", bucket: "highlights", title: "清空全部划线？" })} disabled={!highlightCount}>清空划线</button>
        {documents.length > 0 && <button type="button" onClick={() => confirm({ kind: "clear", bucket: "documents", title: "清空全部导入书？" })}>清空导入书</button>}
      </div>
      {status && <p className="inline-status" role="status">{status}</p>}
      {error && <p className="inline-status error" role="alert">{error}</p>}

      <dialog ref={dialogRef} className="data-confirm" aria-labelledby="data-confirm-title">
        <h3 id="data-confirm-title">{pending?.title}</h3>
        {pending?.kind === "restore" && (
          <p>备份含 {pending.summary.documents} 本书、{pending.summary.vocabulary} 个生词、{pending.summary.highlights} 条划线。恢复会覆盖当前个人数据，失败时会尝试回滚。</p>
        )}
        {pending?.kind === "document" && <p>将删除书籍、阅读位置和该书划线；收藏的生词会保留，但不能再打开原文。</p>}
        {pending?.kind === "clear" && <p>{pending.bucket === "documents" ? "将删除所有导入书及其位置和划线，生词保留。" : "此操作无法撤销，建议先导出备份。"}</p>}
        {error && <p className="inline-status error" role="alert">{error}</p>}
        <div className="data-confirm-actions">
          <form method="dialog"><button type="submit">取消</button></form>
          <button type="button" className="danger-button" onClick={execute} disabled={busy}>{busy ? "处理中…" : "确认"}</button>
        </div>
      </dialog>
    </section>
  );
}
