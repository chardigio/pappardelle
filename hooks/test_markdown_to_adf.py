#!/usr/bin/env python3
"""
Tests for markdown_to_adf.py converter module.

Run with: uv run pytest hooks/test_markdown_to_adf.py -v
Or from hooks dir: python3 -m pytest test_markdown_to_adf.py -v
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_module_path = Path(__file__).parent / "markdown_to_adf.py"
_spec = importlib.util.spec_from_file_location("markdown_to_adf", _module_path)
assert _spec is not None
assert _spec.loader is not None
mod = importlib.util.module_from_spec(_spec)
sys.modules["markdown_to_adf"] = mod
_spec.loader.exec_module(mod)

markdown_to_adf = mod.markdown_to_adf
markdown_to_adf_json = mod.markdown_to_adf_json
_parse_inline = mod._parse_inline


class TestDocStructure:
    def test_empty_input(self):
        result = markdown_to_adf("")
        assert result == {"version": 1, "type": "doc", "content": []}

    def test_doc_wrapper(self):
        result = markdown_to_adf("Hello")
        assert result["version"] == 1
        assert result["type"] == "doc"
        assert isinstance(result["content"], list)


class TestHeadings:
    """Headings are rendered as bold paragraphs due to acli heading node bug."""

    def test_h1_is_bold_paragraph(self):
        result = markdown_to_adf("# Title")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        assert node["content"][0]["text"] == "Title"
        assert {"type": "strong"} in node["content"][0]["marks"]

    def test_h2_is_bold_paragraph(self):
        result = markdown_to_adf("## Section")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        assert node["content"][0]["text"] == "Section"
        assert {"type": "strong"} in node["content"][0]["marks"]

    def test_h3_is_bold_paragraph(self):
        result = markdown_to_adf("### Subsection")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        assert {"type": "strong"} in node["content"][0]["marks"]

    def test_heading_with_inline_formatting_all_bold(self):
        result = markdown_to_adf("## **Bold** heading")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        # All inline nodes in a heading should have strong mark
        for inline in node["content"]:
            assert any(m["type"] == "strong" for m in inline.get("marks", []))

    def test_heading_with_emoji(self):
        result = markdown_to_adf("### 📋 Implementation Plan")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        assert "📋 Implementation Plan" in node["content"][0]["text"]
        assert {"type": "strong"} in node["content"][0]["marks"]


class TestParagraphs:
    def test_simple_paragraph(self):
        result = markdown_to_adf("Hello world")
        node = result["content"][0]
        assert node["type"] == "paragraph"
        assert node["content"][0]["text"] == "Hello world"

    def test_multiple_paragraphs(self):
        result = markdown_to_adf("First paragraph\n\nSecond paragraph")
        assert len(result["content"]) == 2
        assert result["content"][0]["type"] == "paragraph"
        assert result["content"][1]["type"] == "paragraph"

    def test_multiline_paragraph(self):
        result = markdown_to_adf("Line one\nLine two")
        # Consecutive non-blank lines join into one paragraph
        assert len(result["content"]) == 1
        assert "Line one" in result["content"][0]["content"][0]["text"]
        assert "Line two" in result["content"][0]["content"][0]["text"]


class TestInlineFormatting:
    def test_bold(self):
        nodes = _parse_inline("Some **bold** text")
        assert nodes[0]["text"] == "Some "
        assert nodes[1]["text"] == "bold"
        assert nodes[1]["marks"][0]["type"] == "strong"
        assert nodes[2]["text"] == " text"

    def test_italic_underscore(self):
        nodes = _parse_inline("Some _italic_ text")
        assert nodes[1]["text"] == "italic"
        assert nodes[1]["marks"][0]["type"] == "em"

    def test_italic_star(self):
        nodes = _parse_inline("Some *italic* text")
        assert nodes[1]["text"] == "italic"
        assert nodes[1]["marks"][0]["type"] == "em"

    def test_inline_code(self):
        nodes = _parse_inline("Use `git commit` here")
        assert nodes[1]["text"] == "git commit"
        assert nodes[1]["marks"][0]["type"] == "code"

    def test_plain_text_only(self):
        nodes = _parse_inline("No formatting here")
        assert len(nodes) == 1
        assert nodes[0]["text"] == "No formatting here"
        assert "marks" not in nodes[0]

    def test_mixed_formatting(self):
        nodes = _parse_inline("**bold** and `code` and _italic_")
        bold = [n for n in nodes if n.get("marks", [{}])[0].get("type") == "strong"]
        code = [n for n in nodes if n.get("marks", [{}])[0].get("type") == "code"]
        italic = [n for n in nodes if n.get("marks", [{}])[0].get("type") == "em"]
        assert len(bold) == 1
        assert len(code) == 1
        assert len(italic) == 1


class TestBulletLists:
    def test_simple_list(self):
        result = markdown_to_adf("- Item 1\n- Item 2\n- Item 3")
        node = result["content"][0]
        assert node["type"] == "bulletList"
        assert len(node["content"]) == 3
        assert node["content"][0]["type"] == "listItem"

    def test_list_item_with_formatting(self):
        result = markdown_to_adf("- ✅ **Bold item**: description")
        node = result["content"][0]
        item_para = node["content"][0]["content"][0]  # listItem -> paragraph
        # Should contain bold formatting
        texts = [n["text"] for n in item_para["content"]]
        assert any("Bold item" in t for t in texts)

    def test_star_bullet_list(self):
        result = markdown_to_adf("* Item A\n* Item B")
        node = result["content"][0]
        assert node["type"] == "bulletList"
        assert len(node["content"]) == 2


class TestOrderedLists:
    def test_simple_ordered_list(self):
        result = markdown_to_adf("1. First\n2. Second\n3. Third")
        node = result["content"][0]
        assert node["type"] == "orderedList"
        assert len(node["content"]) == 3


class TestHorizontalRules:
    def test_dashes(self):
        result = markdown_to_adf("---")
        assert result["content"][0]["type"] == "rule"

    def test_underscores(self):
        result = markdown_to_adf("___")
        assert result["content"][0]["type"] == "rule"

    def test_long_dashes(self):
        result = markdown_to_adf("-----")
        assert result["content"][0]["type"] == "rule"


class TestBlockquotes:
    def test_simple_blockquote(self):
        result = markdown_to_adf("> Quoted text here")
        node = result["content"][0]
        assert node["type"] == "blockquote"
        assert node["content"][0]["content"][0]["text"] == "Quoted text here"

    def test_multiline_blockquote(self):
        result = markdown_to_adf("> Line one\n> Line two")
        node = result["content"][0]
        assert node["type"] == "blockquote"
        # Both lines should be in the same blockquote
        text = node["content"][0]["content"][0]["text"]
        assert "Line one" in text
        assert "Line two" in text


class TestCodeBlocks:
    def test_code_block_with_language(self):
        result = markdown_to_adf("```python\ndef hello():\n    pass\n```")
        node = result["content"][0]
        assert node["type"] == "codeBlock"
        assert node["attrs"]["language"] == "python"
        assert "def hello():" in node["content"][0]["text"]

    def test_code_block_no_language(self):
        result = markdown_to_adf("```\nsome code\n```")
        node = result["content"][0]
        assert node["type"] == "codeBlock"
        assert "attrs" not in node or "language" not in node.get("attrs", {})

    def test_code_block_preserves_content(self):
        code = "if x > 0:\n    print(x)\n    return True"
        result = markdown_to_adf(f"```python\n{code}\n```")
        assert result["content"][0]["content"][0]["text"] == code


class TestComplexDocuments:
    def test_plan_description(self):
        """Test the typical plan description format from post-plan-to-tracker.py."""
        md = """## Implementation Plan

### Steps

- Step 1: Do something
- Step 2: Do another thing

### Details

Some **important** details about the plan."""

        result = markdown_to_adf(md)
        types = [n["type"] for n in result["content"]]
        # Headings render as bold paragraphs, so all should be "paragraph"
        assert "paragraph" in types
        assert "bulletList" in types

    def test_question_answer_format(self):
        """Test the Q&A comment format from comment-question-answered.py."""
        md = """### 💬 Clarifying Question Answered

❓ **Auth method**: Which auth method?

- ✅ JWT tokens: Stateless auth
- Session cookies: Server-side

💡 **Answer**: JWT tokens"""

        result = markdown_to_adf(md)
        # Heading renders as bold paragraph
        assert result["content"][0]["type"] == "paragraph"
        assert result["content"][1]["type"] == "paragraph"
        assert result["content"][2]["type"] == "bulletList"
        assert result["content"][3]["type"] == "paragraph"

    def test_issue_creation_description(self):
        """Test the initial issue description from provider-helpers.sh."""
        md = """👨‍🍳🍝 More details coming soon...

---

_Original prompt:_

> Fix the bug in the login flow"""

        result = markdown_to_adf(md)
        types = [n["type"] for n in result["content"]]
        assert "paragraph" in types
        assert "rule" in types
        assert "blockquote" in types


class TestJsonOutput:
    def test_json_serializable(self):
        result = markdown_to_adf("## Test\n\n**bold** text")
        # Should not raise
        json_str = json.dumps(result)
        # Should be valid JSON
        parsed = json.loads(json_str)
        assert parsed["version"] == 1

    def test_markdown_to_adf_json_function(self):
        json_str = markdown_to_adf_json("Hello world")
        parsed = json.loads(json_str)
        assert parsed["type"] == "doc"
        assert parsed["content"][0]["content"][0]["text"] == "Hello world"


class TestCLIMode:
    def test_stdin_mode(self):
        script = str(_module_path)
        result = subprocess.run(
            [sys.executable, script],
            input="## Hello\n\nWorld",
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        parsed = json.loads(result.stdout)
        assert parsed["type"] == "doc"
        assert parsed["content"][0]["type"] == "paragraph"  # heading -> bold paragraph

    def test_argument_mode(self):
        script = str(_module_path)
        result = subprocess.run(
            [sys.executable, script, "## Test"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        parsed = json.loads(result.stdout)
        assert parsed["content"][0]["type"] == "paragraph"  # heading -> bold paragraph
