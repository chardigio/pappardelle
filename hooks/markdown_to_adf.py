#!/usr/bin/env python3
"""
Lightweight markdown-to-ADF (Atlassian Document Format) converter.

Converts a subset of markdown used by Pappardelle hooks into ADF JSON suitable
for Jira issue descriptions and comments via `acli --description-file` / `--body-file`.

Supported markdown:
- Headings (## / ### / ####) — rendered as bold paragraphs due to acli heading bug
- Bold (**text**)
- Italic (_text_ or *text*)
- Inline code (`code`)
- Bullet lists (- item or * item)
- Ordered lists (1. item)
- Horizontal rules (--- or ___)
- Blockquotes (> text)
- Code blocks (```language ... ```)
- Paragraphs (separated by blank lines)

Note: acli rejects ADF heading nodes with InvalidPayloadException for all operations
(create, edit, comment). As a workaround, headings are rendered as bold paragraphs.

Usage as module:
    from markdown_to_adf import markdown_to_adf
    adf_json = markdown_to_adf("## Hello\\n\\nSome **bold** text")

Usage as CLI (for bash integration):
    echo "## Hello" | python3 markdown_to_adf.py
    python3 markdown_to_adf.py "## Hello world"
"""

import json
import re
import sys
from typing import Any


def _parse_inline(text: str) -> list[dict[str, Any]]:
    """Parse inline markdown formatting into ADF inline nodes.

    Handles bold (**text**), italic (_text_ / *text*), inline code (`code`),
    and plain text.
    """
    nodes: list[dict[str, Any]] = []
    # Pattern matches: `code`, **bold**, *italic*, _italic_
    pattern = re.compile(
        r"(`[^`]+`)"  # inline code
        r"|(\*\*[^*]+\*\*)"  # bold
        r"|(?<!\w)(\*[^*]+\*)(?!\w)"  # italic with *
        r"|(?<!\w)(_[^_]+_)(?!\w)"  # italic with _
    )

    pos = 0
    for match in pattern.finditer(text):
        # Add plain text before this match
        if match.start() > pos:
            plain = text[pos : match.start()]
            if plain:
                nodes.append({"type": "text", "text": plain})

        code, bold, italic_star, italic_under = match.groups()

        if code:
            nodes.append(
                {
                    "type": "text",
                    "text": code[1:-1],
                    "marks": [{"type": "code"}],
                }
            )
        elif bold:
            nodes.append(
                {
                    "type": "text",
                    "text": bold[2:-2],
                    "marks": [{"type": "strong"}],
                }
            )
        elif italic_star:
            nodes.append(
                {
                    "type": "text",
                    "text": italic_star[1:-1],
                    "marks": [{"type": "em"}],
                }
            )
        elif italic_under:
            nodes.append(
                {
                    "type": "text",
                    "text": italic_under[1:-1],
                    "marks": [{"type": "em"}],
                }
            )

        pos = match.end()

    # Add remaining plain text
    if pos < len(text):
        remaining = text[pos:]
        if remaining:
            nodes.append({"type": "text", "text": remaining})

    # If nothing was parsed, return the whole text as a single node
    if not nodes and text:
        nodes.append({"type": "text", "text": text})

    return nodes


def _make_paragraph(text: str) -> dict[str, Any]:
    """Create a paragraph node with inline formatting."""
    content = _parse_inline(text)
    return {"type": "paragraph", "content": content}


def markdown_to_adf(markdown: str) -> dict[str, Any]:
    """Convert markdown text to an ADF document.

    Args:
        markdown: Markdown-formatted string.

    Returns:
        ADF document as a Python dict (JSON-serializable).
    """
    lines = markdown.split("\n")
    doc_content: list[dict[str, Any]] = []

    i = 0
    while i < len(lines):
        line = lines[i]

        # Code block: ```language ... ```
        if line.startswith("```"):
            lang = line[3:].strip() or None
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing ```
            node: dict[str, Any] = {
                "type": "codeBlock",
                "content": [{"type": "text", "text": "\n".join(code_lines)}],
            }
            if lang:
                node["attrs"] = {"language": lang}
            doc_content.append(node)
            continue

        # Heading: ## text — rendered as bold paragraph (acli rejects heading nodes)
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading_match:
            text = heading_match.group(2).strip()
            # Wrap entire heading text in strong mark, preserving any inner formatting
            inline_nodes = _parse_inline(text)
            for node in inline_nodes:
                existing_marks = node.get("marks", [])
                if not any(m["type"] == "strong" for m in existing_marks):
                    node["marks"] = existing_marks + [{"type": "strong"}]
            doc_content.append({"type": "paragraph", "content": inline_nodes})
            i += 1
            continue

        # Horizontal rule: --- or ___
        if re.match(r"^(-{3,}|_{3,})$", line.strip()):
            doc_content.append({"type": "rule"})
            i += 1
            continue

        # Blockquote: > text (collect consecutive lines)
        if line.startswith("> ") or line == ">":
            quote_lines = []
            while i < len(lines) and (lines[i].startswith("> ") or lines[i] == ">"):
                quote_text = lines[i][2:] if lines[i].startswith("> ") else ""
                quote_lines.append(quote_text)
                i += 1
            # Parse the blockquote content as paragraphs
            quote_content = []
            current_para: list[str] = []
            for ql in quote_lines:
                if ql.strip() == "":
                    if current_para:
                        quote_content.append(_make_paragraph(" ".join(current_para)))
                        current_para = []
                else:
                    current_para.append(ql)
            if current_para:
                quote_content.append(_make_paragraph(" ".join(current_para)))
            if quote_content:
                doc_content.append({"type": "blockquote", "content": quote_content})
            continue

        # Bullet list: - item or * item (collect consecutive list items)
        if re.match(r"^[-*]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i]):
                item_text = re.sub(r"^[-*]\s+", "", lines[i])
                items.append(
                    {
                        "type": "listItem",
                        "content": [_make_paragraph(item_text)],
                    }
                )
                i += 1
            doc_content.append({"type": "bulletList", "content": items})
            continue

        # Ordered list: 1. item (collect consecutive list items)
        if re.match(r"^\d+\.\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                item_text = re.sub(r"^\d+\.\s+", "", lines[i])
                items.append(
                    {
                        "type": "listItem",
                        "content": [_make_paragraph(item_text)],
                    }
                )
                i += 1
            doc_content.append({"type": "orderedList", "content": items})
            continue

        # Blank line: skip
        if line.strip() == "":
            i += 1
            continue

        # Paragraph: collect consecutive non-blank, non-special lines
        para_lines = []
        while i < len(lines):
            current = lines[i]
            if current.strip() == "":
                break
            if current.startswith("```"):
                break
            if re.match(r"^#{1,6}\s+", current):
                break
            if re.match(r"^(-{3,}|_{3,})$", current.strip()):
                break
            if current.startswith("> "):
                break
            if re.match(r"^[-*]\s+", current):
                break
            if re.match(r"^\d+\.\s+", current):
                break
            para_lines.append(current)
            i += 1

        if para_lines:
            doc_content.append(_make_paragraph(" ".join(para_lines)))
        continue

    return {"version": 1, "type": "doc", "content": doc_content}


def markdown_to_adf_json(markdown: str) -> str:
    """Convert markdown to ADF and return as JSON string."""
    return json.dumps(markdown_to_adf(markdown))


if __name__ == "__main__":
    # CLI mode: read from argument or stdin, output ADF JSON to stdout
    if len(sys.argv) > 1:
        md_input = sys.argv[1]
    else:
        md_input = sys.stdin.read()
    print(markdown_to_adf_json(md_input))
