/** Debounce function calls — default 300ms. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms = 300,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
