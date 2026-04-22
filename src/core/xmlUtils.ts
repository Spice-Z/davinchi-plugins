import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { select } from "xpath";

export function parseXmlDocument(xmlPath: string): Document {
  const xml = readFileSync(xmlPath, "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root) {
    throw new Error("Invalid XML: no document element.");
  }
  return doc;
}

/** Remove a leading XML declaration so we emit exactly one (xmldom often includes its own). */
function stripLeadingXmlDeclaration(xml: string): string {
  let s = xml;
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  return s.replace(/^\s*<\?xml\b[^?]*\?>\s*/i, "");
}

export function writeXmlDocument(doc: Document, outputPath: string): void {
  const serializer = new XMLSerializer();
  const serialized = serializer.serializeToString(doc);
  const body = stripLeadingXmlDeclaration(serialized).trimStart();
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  writeFileSync(outputPath, out, "utf8");
}

export function listChildNodes(parent: Node): ChildNode[] {
  const out: ChildNode[] = [];
  const { length } = parent.childNodes;
  for (let i = 0; i < length; i++) {
    out.push(parent.childNodes.item(i)!);
  }
  return out;
}

export function localTagName(el: Element): string {
  return (el.localName ?? el.nodeName.split(":").pop() ?? el.nodeName).toLowerCase();
}

export function findChildElement(parent: Element, tag: string): Element | null {
  const t = tag.toLowerCase();
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && localTagName(c as Element) === t) {
      return c as Element;
    }
  }
  return null;
}

/** XPath-based collection (plan stack). */
export function xpathElements(expression: string, context: Node): Element[] {
  const raw = select(expression, context, false);
  const nodes: Node[] = Array.isArray(raw) ? (raw as Node[]) : raw != null ? [raw as Node] : [];
  return nodes.filter((n): n is Element => n.nodeType === 1) as Element[];
}

export function getIntChildText(node: Element, tag: string): number | null {
  const child = findChildElement(node, tag);
  if (!child || child.textContent == null) return null;
  const text = child.textContent.trim();
  if (!text) return null;
  const v = Number.parseFloat(text);
  if (Number.isNaN(v)) return null;
  return Math.trunc(v);
}

export function setIntChildText(node: Element, tag: string, value: number): void {
  let child = findChildElement(node, tag);
  if (!child) {
    child = node.ownerDocument!.createElement(tag);
    node.appendChild(child);
  }
  child.textContent = String(Math.trunc(value));
}
