"""CLI entry point: python __main__.py <instagram_url>"""

import sys
from dotenv import load_dotenv

load_dotenv()

from agent import run_agent


def main():
    if len(sys.argv) != 2:
        print("Usage: python __main__.py <instagram_url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    try:
        transcript = run_agent(url)
        print(transcript)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
