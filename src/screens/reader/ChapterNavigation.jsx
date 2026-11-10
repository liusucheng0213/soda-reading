export function ChapterNavigation({ chapters, currentId, chapterOffsets = {}, onSelect }) {
  return (
    <nav className="chapter-navigation" aria-label="章节目录">
      <ol>
        {chapters.map((chapter, index) => {
          const current = chapter.id === currentId;
          const complete = Number(chapterOffsets[chapter.id]) >= 0.95;
          return (
            <li key={chapter.id}>
              <button
                type="button"
                className={current ? "active" : ""}
                aria-current={current ? "step" : undefined}
                onClick={() => onSelect(chapter.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{chapter.title}</strong>
                {complete && <small>已读完</small>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
