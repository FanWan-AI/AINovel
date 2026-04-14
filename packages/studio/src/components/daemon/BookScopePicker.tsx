import type { TFunction } from "../../hooks/use-i18n";

export interface DaemonBookOption {
  readonly id: string;
  readonly title: string;
}

export type DaemonBookScopeType = "all-active" | "book-list";

export function toggleBookSelection(
  selectedBookIds: ReadonlyArray<string>,
  bookId: string,
  checked: boolean,
): string[] {
  if (checked) {
    if (selectedBookIds.includes(bookId)) return [...selectedBookIds];
    return [...selectedBookIds, bookId];
  }
  return selectedBookIds.filter((id) => id !== bookId);
}

export function BookScopePicker({
  t,
  scopeType,
  books,
  selectedBookIds,
  onScopeTypeChange,
  onSelectedBookIdsChange,
}: {
  readonly t: TFunction;
  readonly scopeType: DaemonBookScopeType;
  readonly books: ReadonlyArray<DaemonBookOption>;
  readonly selectedBookIds: ReadonlyArray<string>;
  readonly onScopeTypeChange: (scopeType: DaemonBookScopeType) => void;
  readonly onSelectedBookIdsChange: (bookIds: ReadonlyArray<string>) => void;
}) {
  return (
    <div className="space-y-3 sm:col-span-2 lg:col-span-3">
      <div className="text-xs font-medium text-muted-foreground">{t("rc.bookScopeLabel")}</div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            checked={scopeType === "all-active"}
            onChange={() => onScopeTypeChange("all-active")}
          />
          <span>{t("rc.scopeAllActive")}</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            checked={scopeType === "book-list"}
            onChange={() => onScopeTypeChange("book-list")}
          />
          <span>{t("rc.scopeBookList")}</span>
        </label>
      </div>

      {scopeType === "book-list" && (
        <div className="rounded-md border border-border/70 p-3 space-y-2">
          {books.length === 0 ? (
            <div className="text-xs text-muted-foreground">{t("rc.bookScopeNoActive")}</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {books.map((book) => {
                const checked = selectedBookIds.includes(book.id);
                return (
                  <label key={book.id} className="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        onSelectedBookIdsChange(toggleBookSelection(selectedBookIds, book.id, e.target.checked));
                      }}
                    />
                    <span className="truncate">{book.title}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
