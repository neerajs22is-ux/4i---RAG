import { ImageResponse } from "next/og";

/**
 * Social share image for the public landing page.
 *
 * Generated with the framework's own renderer (no new dependency): the brand
 * tile, the headline and one evidence-row motif, drawn with the brand's hex
 * colours because the OG renderer does not resolve CSS custom properties.
 */
export const alt =
  "RAG-4i: ask your documents, get answers with the evidence attached";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#17191c",
          padding: "72px 80px",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "#fad905",
              color: "#101114",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            4i
          </div>
          <div style={{ color: "#e4e5e7", fontSize: 30, fontWeight: 600 }}>
            RAG-4i
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: "#e4e5e7",
              fontSize: 62,
              lineHeight: 1.1,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              maxWidth: 900,
            }}
          >
            Ask your documents. Get answers with the evidence attached.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              border: "1px solid rgba(228,229,231,0.22)",
              borderRadius: 14,
              padding: "18px 22px",
              maxWidth: 820,
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: "#313535",
                color: "#e4e5e7",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
              }}
            >
              1
            </div>
            <div
              style={{
                color: "#9297a0",
                fontSize: 26,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              Year-End Procedures.pdf · p. 22 · verbatim excerpt attached
            </div>
          </div>
        </div>

        <div style={{ color: "#9297a0", fontSize: 24 }}>
          Answers refuse rather than guess when the evidence is not there.
        </div>
      </div>
    ),
    { ...size },
  );
}
