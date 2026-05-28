import type { PreviewElement, PreviewSpec } from "../types";

function renderElement(element: PreviewElement): string {
  const opacity = element.opacity !== undefined ? ` opacity="${element.opacity}"` : "";

  switch (element.kind) {
    case "rect":
      return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="${element.radius ?? 0}" ry="${element.radius ?? 0}" fill="${element.fill}" stroke="${element.stroke ?? "none"}" stroke-width="${element.strokeWidth ?? 0}"${opacity} />`;
    case "circle":
      return `<circle cx="${element.cx}" cy="${element.cy}" r="${element.r}" fill="${element.fill}" stroke="${element.stroke ?? "none"}" stroke-width="${element.strokeWidth ?? 0}"${opacity} />`;
    case "polyline":
      return `<polyline points="${element.points}" fill="none" stroke="${element.stroke}" stroke-width="${element.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${element.dashed ? ' stroke-dasharray="8 7"' : ""}${opacity} />`;
    case "text":
      return `<text x="${element.x}" y="${element.y}" text-anchor="${element.anchor ?? "start"}" class="${element.className ?? ""}" fill="${element.fill ?? "currentColor"}"${opacity}>${element.text}</text>`;
  }
}

export function renderPreviewSvg(spec: PreviewSpec): string {
  const legend = spec.legend
    .map(
      (item, index) =>
        `<g transform="translate(${16 + index * 78}, 176)">
          <rect x="0" y="0" width="14" height="14" rx="3" fill="${item.swatch}" />
          <text x="20" y="11" class="preview__legend">${item.label}</text>
        </g>`,
    )
    .join("");

  return `
    <svg class="preview" viewBox="${spec.viewBox}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top-down tactical map preview">
      <rect x="0" y="0" width="260" height="200" fill="${spec.background}" />
      ${spec.elements.map(renderElement).join("")}
      ${legend}
    </svg>
  `;
}
