import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DL_LABEL, autoDownloadOn, downloadArgv, downloadError, downloadView, missingVideos, nextAutoDownload, parseProgress, validateDownload, videoFileOf } from "./downloads.ts";
import { creatableFolder, isFolderName, minimalMatchYaml } from "./matchFolder.ts";
import { createMatchFolderOnDisk } from "./matchFolderDisk.ts";
import { matchSteps } from "./steps.ts";

const V = (id, yt = "OIvhk-vNs5c") => ({ video_id: id, youtube_id: yt, label: id });
const ok = { match: "2026_10_10_tec_ccm_vs_up", video: "v2", youtubeId: "OIvhk-vNs5c" };

test("validation of the ids that reach the command line", () => {
  assert.equal(validateDownload(ok).ok, true);
  assert.deepEqual(downloadArgv(ok), ["-m", "sportsan.ingest.download_videos", "--match", ok.match, "--video", "v2", "--youtube-id", "OIvhk-vNs5c"]);
  for (const bad of [
    { ...ok, match: "../x" },
    { ...ok, match: "a b" },
    { ...ok, match: "a;rm" },
    { ...ok, video: "v1; ls" },
    { ...ok, video: "video" },
    { ...ok, youtubeId: "short" },
    { ...ok, youtubeId: "OIvhk-vNs5c; ls" },
    { ...ok, youtubeId: "https://youtu.be/OIvhk-vNs5c" },
    { ...ok, youtubeId: 12345678901 },
    null,
    "x",
  ])
    assert.equal(validateDownload(bad).ok, false, JSON.stringify(bad));
});

test("the file of a video is the finished one", () => {
  assert.equal(videoFileOf(["v1.mp4", "v2.mp4.part"], "v1"), "v1.mp4");
  assert.equal(videoFileOf(["v1.f137.mp4", "v1.mp4.part", "v1_proxy.mp4", "v10.mp4"], "v1"), null);
  assert.equal(videoFileOf(["v1.webm"], "v1"), "v1.webm");
  assert.equal(videoFileOf(null, "v1"), null);
});

test("missing videos: only registered with a link, only when the folder is readable", () => {
  const vs = [V("v1"), V("v2"), V("v3", "")];
  assert.deepEqual(missingVideos(vs, ["v1.mp4"]).map((v) => v.video_id), ["v2"]);
  assert.deepEqual(missingVideos(vs, null), []);
  assert.deepEqual(missingVideos(vs, ["v1.mp4", "v2.mp4"]), []);
});

test("progress of yt-dlp", () => {
  assert.deepEqual(parseProgress("[download]  45.3% of ~ 1.20GiB at 3.4MiB/s ETA 05:12"), { pct: 45.3, etaS: 312 });
  assert.deepEqual(parseProgress("[download] 100% of 1.20GiB in 00:03:10 at 6.1MiB/s"), { pct: 100, etaS: null });
  assert.deepEqual(parseProgress("[download]   2.0% of 900MiB at 1MiB/s ETA 1:02:03"), { pct: 2, etaS: 3723 });
  assert.equal(parseProgress("[youtube] Extracting URL"), null);
  assert.equal(parseProgress(undefined), null);
});

test("states: pendiente -> descargando -> descargado / error", () => {
  const base = { hasLink: true, videoId: "v1" };
  assert.equal(downloadView({ ...base, names: [], job: null }).state, "pending");
  const running = { state: "running", tail: ["[youtube] x", "[download]  10.0% of 1GiB ETA 10:00", "[download]  45.3% of 1GiB ETA 05:12"] };
  assert.deepEqual(downloadView({ ...base, names: [], job: running }), { state: "downloading", pct: 45.3, etaS: 312, message: "" });
  assert.equal(downloadView({ ...base, names: [], job: { state: "running", last: "[youtube] Extracting" } }).pct, null);
  assert.equal(downloadView({ ...base, names: ["v1.mp4"], job: { state: "done" } }).state, "ready");
  const failed = downloadView({ ...base, names: [], job: { state: "failed", tail: ["ERROR: Video unavailable"] } });
  assert.equal(failed.state, "error");
  assert.match(failed.message, /no está disponible/);
  assert.equal(downloadView({ ...base, names: [], job: { state: "done" } }).state, "error");
  assert.equal(downloadView({ ...base, names: [], job: { state: "stopped" } }).state, "stopped");
  assert.equal(downloadView({ ...base, names: null, job: null }).state, "unknown");
  assert.equal(downloadView({ hasLink: false, names: [], videoId: "v1", job: null }).state, "nolink");
  assert.equal(DL_LABEL.unknown, "");
  assert.match(downloadError(["No encuentro yt-dlp. Instálalo"]), /yt-dlp/);
});

test("automatic download: one video at a time, never twice, never after an error", () => {
  const vs = [V("v1"), V("v2")];
  const base = { auto: true, names: [], videos: vs, jobs: [], attempted: new Set() };
  assert.equal(nextAutoDownload(base), "v1");
  // already downloading (any video): wait
  assert.equal(nextAutoDownload({ ...base, jobs: [{ kind: "download", video: "v1", state: "running" }] }), null);
  // v1 failed: it is not retried by itself; the next one goes
  assert.equal(nextAutoDownload({ ...base, jobs: [{ kind: "download", video: "v1", state: "failed" }] }), "v2");
  assert.equal(nextAutoDownload({ ...base, jobs: [{ kind: "download", video: "v1", state: "stopped" }, { kind: "download", video: "v2", state: "failed" }] }), null);
  // already tried in this session
  assert.equal(nextAutoDownload({ ...base, attempted: new Set(["v1", "v2"]) }), null);
  // the file is there / the folder is unreachable / no link / invalid id
  assert.equal(nextAutoDownload({ ...base, names: ["v1.mp4", "v2.mp4"] }), null);
  assert.equal(nextAutoDownload({ ...base, names: null }), null);
  assert.equal(nextAutoDownload({ ...base, videos: [V("v1", "")] }), null);
  assert.equal(nextAutoDownload({ ...base, videos: [V("v1", "no es un id")] }), null);
  // other kinds of job do not count
  assert.equal(nextAutoDownload({ ...base, jobs: [{ kind: "process", video: "v1", state: "running" }] }), "v1");
});

test("the switch is on unless it was turned off", () => {
  assert.equal(autoDownloadOn({}), true);
  assert.equal(autoDownloadOn({ tech: {} }), true);
  assert.equal(autoDownloadOn({ tech: { autoDownload: false } }), false);
  assert.equal(autoDownloadOn({ tech: { autoDownload: true } }), true);
  assert.equal(autoDownloadOn(undefined), true);
  // switch off: nothing starts
  assert.equal(nextAutoDownload({ auto: false, names: [], videos: [V("v1")], jobs: [], attempted: new Set() }), null);
});

test("folder names and the folders that may be created", () => {
  assert.equal(isFolderName("2026_10_10_tec_ccm_vs_up"), true);
  assert.equal(isFolderName("2026_13_10_tec_vs_up"), false);
  assert.equal(isFolderName("partido_ccm_vs_up"), false);
  assert.equal(creatableFolder("matches/2026_10_10_tec_ccm_vs_up"), "2026_10_10_tec_ccm_vs_up");
  for (const bad of ["matches/..", "matches/2026_10_10_a_vs_b/video", "data/2026_10_10_a_vs_b", "matches/../2026_10_10_a_vs_b", "matches/2026_10_10_A_vs_b", "2026_10_10_a_vs_b"])
    assert.equal(creatableFolder(bad), null, bad);
});

test("minimal match.yaml", () => {
  const y = minimalMatchYaml("2026_10_10_tec_ccm_vs_up", { kind: "rival", date: "2026-10-10", own_team_name: 'Tec "CCM"', other_team_name: "UP" });
  assert.ok(y.startsWith('match_id: 2026_10_10_tec_ccm_vs_up\nkind: rival\ndate: "2026-10-10"\nown_team_name: "Tec \\"CCM\\""\nother_team_name: "UP"\n'));
  assert.match(y, /venue:\n {2}name: "REEMPLAZAR"/);
  assert.ok(y.endsWith("\nvideos:\n"));
  assert.match(minimalMatchYaml("x", { kind: "otro", date: "10/10" }), /kind: own\ndate: "REEMPLAZAR"/);
});

test("the folder is created without overwriting anything", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sportsan-"));
  try {
    const rel = "matches/2026_10_10_tec_ccm_vs_up";
    const r = await createMatchFolderOnDisk(root, rel, { kind: "own", date: "2026-10-10", own_team_name: "Tec CCM", other_team_name: "UP" });
    assert.deepEqual(r, { ok: true, created: true, yaml: true });
    const dir = path.join(root, rel);
    assert.deepEqual((await readdir(dir)).sort(), ["match.yaml", "tracking", "video"]);
    // an existing match.yaml and video stay as they are
    await writeFile(path.join(dir, "match.yaml"), "match_id: mio\n");
    await writeFile(path.join(dir, "video", "v1.mp4"), "video");
    const again = await createMatchFolderOnDisk(root, rel, { kind: "rival" });
    assert.deepEqual(again, { ok: true, created: false, yaml: false });
    assert.equal(await readFile(path.join(dir, "match.yaml"), "utf-8"), "match_id: mio\n");
    assert.equal(await readFile(path.join(dir, "video", "v1.mp4"), "utf-8"), "video");
    // a folder with no match.yaml gets one without losing its files
    await mkdir(path.join(root, "matches", "2026_10_11_a_vs_b"));
    await writeFile(path.join(root, "matches", "2026_10_11_a_vs_b", "notas.txt"), "n");
    const half = await createMatchFolderOnDisk(root, "matches/2026_10_11_a_vs_b", {});
    assert.deepEqual(half, { ok: true, created: false, yaml: true });
    assert.ok((await readdir(path.join(root, "matches", "2026_10_11_a_vs_b"))).includes("notas.txt"));
    // names outside the convention or outside matches/ are refused and nothing is written
    for (const bad of ["matches/../fuera", "matches/partido_viejo", "data/2026_10_10_a_vs_b", "matches/2026_10_10_a_vs_b/video"]) {
      const x = await createMatchFolderOnDisk(root, bad, {});
      assert.equal(x.ok, false, bad);
    }
    assert.deepEqual((await readdir(path.join(root, "matches"))).sort(), ["2026_10_10_tec_ccm_vs_up", "2026_10_11_a_vs_b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("steps say «falta el video» only when the folder was listed", () => {
  const base = { videoIds: ["v1", "v2"], linked: ["v1", "v2"], segmentsByVideo: {}, events: [], plays: [], trackEdits: [], folder: "f" };
  const s = matchSteps({ ...base, files: { tracking: [], video: ["v1.mp4"] } });
  assert.match(s.calibration.text, /falta el video$/);
  assert.match(s.tracking.text, /falta el video$/);
  const both = matchSteps({ ...base, files: { tracking: [], video: [] } });
  assert.match(both.calibration.text, /falta el video \(v1, v2\)$/);
  const full = matchSteps({ ...base, files: { tracking: [], video: ["v1.mp4", "v2.mp4"] } });
  assert.doesNotMatch(full.calibration.text, /falta el video/);
  // folder not listed (web) or listing without video/: not reported
  assert.doesNotMatch(matchSteps({ ...base, files: { tracking: [] } }).tracking.text, /falta el video/);
  assert.doesNotMatch(matchSteps({ ...base, files: null }).calibration.text, /falta el video/);
});
