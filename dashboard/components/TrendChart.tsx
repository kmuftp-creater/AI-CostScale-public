type Point = { date: string; spend: number };

/**
 * 純資料驅動的每日成本折線圖。沒有資料時由呼叫端顯示空狀態，這裡只負責畫圖。
 * unit 是金額前綴：總覽的閘道成本是 US$，帳單頁是 NT$（D-2 加）。
 */
export default function TrendChart({ daily, unit = "US$" }: { daily: Point[]; unit?: string }) {
  const width = 1000;
  const height = 250;
  const padLeft = 15;
  const padRight = 15;
  const top = 20;
  const bottom = 225;

  const max = Math.max(...daily.map((d) => d.spend), 0.0001);
  const step = daily.length > 1 ? (width - padLeft - padRight) / (daily.length - 1) : 0;

  const points = daily.map((d, i) => {
    const x = padLeft + step * i;
    const y = bottom - (d.spend / max) * (bottom - top);
    return { x, y };
  });

  const linePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath =
    points.length > 0
      ? `M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} L${points[points.length - 1].x.toFixed(1)},${bottom} ${points[0].x.toFixed(1)},${bottom} Z`
      : "";

  const firstLabel = daily[0]?.date ?? "";
  const lastLabel = daily[daily.length - 1]?.date ?? "";
  const midLabel = daily[Math.floor(daily.length / 2)]?.date ?? "";

  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日成本折線圖">
      <defs>
        <linearGradient id="fillPaid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--rule-soft)" strokeDasharray="2 5">
        <line x1={padLeft} y1={45} x2={width - padRight} y2={45} />
        <line x1={padLeft} y1={105} x2={width - padRight} y2={105} />
        <line x1={padLeft} y1={165} x2={width - padRight} y2={165} />
      </g>
      <line x1={padLeft} y1={bottom} x2={width - padRight} y2={bottom} stroke="var(--rule)" />
      {areaPath ? <path fill="url(#fillPaid)" d={areaPath} /> : null}
      {linePoints ? (
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" points={linePoints} />
      ) : null}
      <text className="axis-label" x={padLeft} y={243}>
        {firstLabel}
      </text>
      <text className="axis-label" x={width / 2} y={243} textAnchor="middle">
        {midLabel}
      </text>
      <text className="axis-label" x={width - padRight} y={243} textAnchor="end">
        {lastLabel}
      </text>
      <text className="axis-label" x={width - padRight} y={40} textAnchor="end">
        {unit}{max.toFixed(2)}
      </text>
    </svg>
  );
}
