const names = ["Circle", "Diamond", "Square", "Triangle", "Hexagon", "Cross", "Star", "Pentagon", "Down triangle", "Plus"];

export function gemMarker(index, radius) {
  const polygon = (count, offset = -Math.PI / 2, inner = null) => {
    const points = Array.from({ length: count }, (_, i) => {
      const angle = offset + i * Math.PI * 2 / count, r = inner !== null && i % 2 ? radius * inner : radius;
      return `${(Math.cos(angle) * r).toFixed(3)},${(Math.sin(angle) * r).toFixed(3)}`;
    }).join(" ");
    return `<polygon points="${points}"/>`;
  };
  const plus = `<path d="M${-radius / 3},${-radius}H${radius / 3}V${-radius / 3}H${radius}V${radius / 3}H${radius / 3}V${radius}H${-radius / 3}V${radius / 3}H${-radius}V${-radius / 3}H${-radius / 3}Z"/>`;
  const shapes = [
    `<circle r="${radius}"/>`, polygon(4),
    `<rect x="${-radius * .8}" y="${-radius * .8}" width="${radius * 1.6}" height="${radius * 1.6}"/>`,
    polygon(3), polygon(6, 0), `<g transform="rotate(45)">${plus}</g>`, polygon(10, -Math.PI / 2, .43),
    polygon(5), polygon(3, Math.PI / 2), plus
  ];
  return { name: names[index] || `${index + 3}-sided polygon`, body: shapes[index] || polygon(index + 3) };
}
