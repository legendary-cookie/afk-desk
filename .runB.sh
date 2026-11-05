for t in 5 6 7; do
  python "C:/Users/Zhen Li/.claude/provider-usage/pu.py" run codex gpt-6.1-terra implementation -- wsl -d Debian --cd "/mnt/c/Users/Zhen Li/ao/wt/parity" -- bash -c "codex exec -m gpt-6.1-terra -c model_reasoning_effort=medium -s workspace-write -o .t$t.out.md - < .t$t.md"
done
