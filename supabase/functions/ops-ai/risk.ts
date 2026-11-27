// Command risk classification + output redaction for the AI operations centre.
// This is a safety net, not a sandbox: it decides which commands the AI may run on its own and which need the owner's approval.
//   read        looks only at the machine (safe to run immediately)
//   change      modifies state in a normally reversible way (restart a service, edit a file, install a package)
//   destructive can lose data or lock the owner out (needs approval unless the server is set to full autonomy)
export type Risk = "read" | "change" | "destructive";

const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(?:-[a-zA-Z-]*\s+)*-[a-zA-Z]*[rRf]/, "recursive/forced delete"],
  [/\brm\s+(?:-[a-zA-Z]+\s+)*--(?:recursive|force)\b/, "recursive/forced delete"],
  [/\b(?:mkfs(?:\.\w+)?|wipefs|shred|fdisk|sfdisk|parted|cryptsetup)\b/, "disk/filesystem operation"],
  [/\bdd\s+[^|;&]*\b(?:of|if)=/, "raw disk copy"],
  [/>\s*\/dev\/(?:sd|nvme|vd|xvd|mmcblk)/, "writes to a disk device"],
  [/\b(?:drop|truncate)\s+(?:database|table|schema)\b/i, "drops data"],
  [/\bdelete\s+from\b/i, "deletes rows"],
  [/\b(?:ufw\s+(?:disable|reset|--force)|iptables\s+(?:-F|--flush|-P\s+\w+\s+DROP)|ip6tables\s+(?:-F|--flush)|nft\s+flush|firewall-cmd\s+--(?:remove|reload))/, "firewall change (can lock out access)"],
  [/\b(?:passwd|chpasswd|usermod|userdel|deluser|adduser|useradd|visudo|gpasswd)\b/, "user/credential change"],
  [/\/etc\/(?:sudoers|ssh\/|shadow|passwd|pam\.d)/, "touches access configuration"],
  [/authorized_keys|\.ssh\//, "touches SSH keys"],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b|\bsystemctl\s+(?:poweroff|reboot|halt|isolate|kexec)\b/, "stops/reboots the machine"],
  [/\bsystemctl\s+(?:disable|mask|stop)\s+[^;|&]*\b(?:ssh|sshd|networking|network|systemd-networkd|NetworkManager)\b/, "stops access/network"],
  [/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R|--recursive)\b/, "recursive permission change"],
  [/\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|network\s+(?:rm|prune)|rmi|image\s+prune|container\s+prune|rm\s+(?:-[a-zA-Z]*f|--force))/, "removes containers/volumes/images"],
  [/\bdocker[\s-]+compose\s+down\b[^;|&]*(?:-v|--volumes|--rmi)/, "removes volumes"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*[fdx])/, "discards work"],
  [/\bkill(?:all)?\s+-(?:9|KILL)\s+(?:1|-1)\b/, "kills init/all"],
  [/\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, "runs remote code"],
  [/:\s*\(\s*\)\s*\{/, "fork bomb"],
  [/\bcrontab\s+-r\b/, "removes all cron jobs"],
  [/\bapt(?:-get)?\s+(?:remove|purge|autoremove)|\b(?:dnf|yum)\s+(?:remove|erase)|\bpip3?\s+uninstall\b|\bnpm\s+(?:uninstall|rm)\s+-g\b/, "removes software"],
  [/\bmv\s+[^;|&]*\s\/dev\/null\b|\btruncate\s+-s\s*0\b|(?:^|[;&|]\s*):\s*>\s*\S/, "empties a file"],
  [/\bsystemctl\s+(?:daemon-reexec)\b|\bsysctl\s+-w\b/, "kernel/system tuning"],
];

// first word of each pipeline segment that only reads
const READ_CMDS = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "df", "du", "free", "uptime", "ps", "pgrep", "top", "journalctl", "dmesg", "whoami", "id", "uname", "hostname", "hostnamectl", "date", "lsb_release", "ss", "netstat", "lsof", "which", "type", "echo", "printf", "wc", "sort", "uniq", "cut", "tr", "stat", "file", "nproc", "lscpu", "lsblk", "uptime", "vmstat", "iostat", "w", "who", "last", "env", "printenv", "locale", "timedatectl", "ping", "dig", "nslookup", "host", "traceroute", "tree", "basename", "dirname", "readlink", "realpath", "test", "true", "false", "sleep", "awk", "sed", "jq", "less", "more", "md5sum", "sha256sum", "sha1sum", "diff", "cmp", "nginx", "caddy", "ufw", "systemctl", "service", "docker", "ip", "curl", "find", "git", "node", "php", "python3", "crontab", "apt", "dpkg", "mount", "certbot"]);

// per-command argument rules for the dual-use commands above
function segmentRisk(seg: string): Risk {
  const s = seg.trim().replace(/^(?:sudo\s+(?:-\S+\s+)*)/, "").replace(/^(?:\w+=\S*\s+)+/, "");
  if (!s) return "read";
  const words = s.split(/\s+/), w0 = words[0].replace(/^.*\//, "");
  if (!READ_CMDS.has(w0)) return "change";
  const rest = words.slice(1).join(" ");
  switch (w0) {
    case "systemctl": return /^(?:-\S+\s+)*(?:status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat)\b/.test(rest) ? "read" : "change";
    case "service": return /\bstatus\b/.test(rest) ? "read" : "change";
    case "docker": return /^(?:-\S+\s+)*(?:ps|logs|inspect|stats|images|info|version|top|port|events|history|diff|volume\s+ls|network\s+ls|compose\s+(?:ps|logs|config|ls)|container\s+(?:ls|inspect|logs))\b/.test(rest) ? "read" : "change";
    case "ip": return /^(?:-\S+\s+)*(?:a|addr|address|r|route|l|link|n|neigh)\b(?!.*\b(?:add|del|delete|flush|set|replace)\b)/.test(rest) ? "read" : "change";
    case "ufw": return /^status\b/.test(rest) ? "read" : "change";
    case "curl": return /(?:^|\s)(?:-X\s*(?!GET)\w+|--request\s+(?!GET)\w+|-d\b|--data\S*|-F\b|--form\b|-T\b|--upload-file|-o\b|-O\b|--output)/.test(rest) ? "change" : "read";
    case "find": return /(?:^|\s)(?:-delete|-exec\S*|-ok\S*|-fprint\S*|-fls)\b/.test(rest) ? "change" : "read";
    case "git": return /^(?:-\S+\s+)*(?:status|log|diff|show|branch|remote|rev-parse|describe|ls-files|config\s+--get)\b/.test(rest) ? "read" : "change";
    case "sed": return /(?:^|\s)-[a-zA-Z]*i/.test(rest) ? "change" : "read";
    case "awk": return /system\s*\(|>\s*["'\w]/.test(rest) ? "change" : "read";
    case "nginx": case "caddy": return /^(?:-t|-T|validate|version|-v|-V)\b/.test(rest) ? "read" : "change";
    case "node": case "php": case "python3": return /^(?:-v|--version|-V)\s*$/.test(rest) ? "read" : "change";
    case "crontab": return /^-l\b/.test(rest) ? "read" : "change";
    case "apt": return /^(?:list|show|search|policy)\b/.test(rest) ? "read" : "change";
    case "dpkg": return /^(?:-l|-s|-L|--list|--status)\b/.test(rest) ? "read" : "change";
    case "mount": return rest ? "change" : "read";
    case "certbot": return /^certificates\b/.test(rest) ? "read" : "change";
    case "top": return /\b-b\b|-[a-zA-Z]*b/.test(rest) ? "read" : "change";
    case "ping": return /(?:^|\s)-c\s*\d+/.test(rest) ? "read" : "change";   // an endless ping would hang the session
    case "sleep": return Number(rest) <= 30 ? "read" : "change";
    case "less": case "more": return "change";
    case "env": case "printenv": return "read";
    default: return "read";
  }
}

export function classify(cmd: string): { risk: Risk; why: string } {
  const c = String(cmd ?? "");
  if (!c.trim()) return { risk: "read", why: "empty" };
  for (const [re, why] of DESTRUCTIVE) if (re.test(c)) return { risk: "destructive", why };
  // writes through redirection / tee / here-docs, command substitution we cannot analyse, nested shells
  let risk: Risk = "read", why = "read-only";
  const bump = (r: Risk, w: string) => { if (r === "change" && risk === "read") { risk = "change"; why = w; } };
  const noQuotes = c.replace(/'[^']*'|"[^"]*"/g, '""');
  if (/(?:^|[^>&0-9])>{1,2}\s*(?!\/dev\/null|&)\S/.test(noQuotes)) bump("change", "writes a file");
  if (/\btee\b/.test(noQuotes)) bump("change", "writes a file");
  if (/<<-?\s*['"]?\w+/.test(c)) bump("change", "here-document");
  if (/\$\(|`/.test(c)) bump("change", "command substitution");
  if (/\b(?:bash|sh|zsh|dash|eval|source)\b\s+(?:-c\b|<|\S)/.test(noQuotes)) bump("change", "nested shell");
  if (/\bxargs\b/.test(noQuotes)) bump("change", "xargs");
  for (const seg of c.split(/\n|;|&&|\|\||\||&(?!>)/)) {
    const r = segmentRisk(seg);
    if (r === "change") bump("change", "modifies state");
  }
  return { risk, why };
}

// Secrets must not reach the stored log or the model: private keys, JWT-like tokens, key=value secrets, long random strings after '='.
export function redact(text: string): string {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted token]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{16,}\b/g, "[redacted key]")
    .replace(/((?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|auth|credential|bearer)\w*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi, "$1[redacted]")
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+(@)/g, "$1[redacted]$2");
}

export const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + `\n…[${s.length - n} chars cut]…\n` + s.slice(-Math.floor(n * 0.4)));
