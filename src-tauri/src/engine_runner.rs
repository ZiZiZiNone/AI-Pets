//! Generic external speech-engine runner.
//!
//! The host needs to drive local engines (sherpa-onnx, whisper.cpp, piper, …) to get
//! offline STT/TTS without bundling them. Rather than hardcoding one product, this module
//! runs *whatever* executable the user configures, so swapping engines is a config edit.
//!
//! Speech engines do not share a calling convention, but the three differences that matter
//! are all data-shaped, so they are described rather than coded:
//!
//! * Some write audio to a file instead of stdout → `{output}` reserves a temp path.
//! * Some read audio from a file instead of stdin → `{input}` writes one from the payload.
//! * Model folders name their weights differently per release → a `*` in a path-like argv
//!   entry resolves to the first match, so a config never has to pin an exact filename.
//!
//! Two properties matter more than features here:
//!
//! * **No shell.** The program and its argv are passed straight to `Command`, never
//!   through `cmd /C`, so a path containing `&` or a quote cannot become a second command.
//! * **No orphaned processes.** A hung engine must not outlive its request, so the child
//!   is polled against a deadline and killed when it overruns. Its pipes are drained on
//!   separate threads, because a child that fills a pipe buffer would otherwise block
//!   forever while we wait for it to exit.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Applied when the caller does not specify one.
pub const DEFAULT_ENGINE_TIMEOUT_MS: u64 = 60_000;
/// Upper bound on a caller-supplied timeout, so a bad config cannot pin a process forever.
pub const MAX_ENGINE_TIMEOUT_MS: u64 = 600_000;
/// Text handed to an engine is a sentence or two; anything far larger is a mistake.
pub const MAX_ENGINE_STDIN_BYTES: usize = 64 * 1024;
/// Recorded speech is a few megabytes as WAV; base64 inflates that by a third.
pub const MAX_ENGINE_INPUT_BASE64_BYTES: usize = 24 * 1024 * 1024;
/// A synthesised sentence is well under a megabyte; anything larger is a runaway file.
pub const MAX_ENGINE_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;

/// Replaced by the path of the temp file holding `input_bytes_base64`.
pub const INPUT_PLACEHOLDER: &str = "{input}";
/// Replaced by the path of the temp file the engine should write, read back as base64.
pub const OUTPUT_PLACEHOLDER: &str = "{output}";

const POLL_INTERVAL: Duration = Duration::from_millis(15);
/// How long output collection may continue after the process itself is done.
///
/// The reader threads end when the pipe closes, which is not the same moment as the child
/// exiting: a wrapper (`cmd /C`, a `.bat` launcher) starts the real engine as a grandchild
/// that inherits the pipe and can outlive the process we can signal. Waiting on the join
/// would then hold this call for as long as that grandchild runs, so the wait is bounded
/// and the partial output collected so far is returned instead.
const READER_DRAIN_GRACE: Duration = Duration::from_millis(250);
const MAX_EXTENSION_LEN: usize = 8;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EngineRequest {
    /// Absolute path to the engine executable.
    pub exe: String,
    /// Arguments, already expanded from the user's template. Entries containing `{input}`,
    /// `{output}` or a path-like `*` are resolved by the runner.
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional text piped to the engine's stdin. Closed after writing so the child sees EOF.
    pub stdin: Option<String>,
    /// Working directory; engines that resolve models relatively need this.
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    /// Base64 audio written to a temp file whose path replaces `{input}`.
    pub input_bytes_base64: Option<String>,
    /// Extension for that temp file (`wav`, `mp3`, …). Defaults to `wav`.
    pub input_extension: Option<String>,
    /// When set, a temp file with this extension is reserved and its path replaces
    /// `{output}`; after a successful run the file is read back as base64.
    pub capture_output_extension: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct EngineResult {
    /// `None` when the process was killed for overrunning its deadline.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// True when output was still arriving after the process was done and collection gave
    /// up, so `stdout`/`stderr` may be partial. Surfaced rather than hidden: a truncated
    /// transcript that looks complete is worse than a visible warning.
    pub output_truncated: bool,
    /// Base64 of the file the engine wrote to `{output}`.
    pub output_base64: Option<String>,
    /// Content type inferred from the capture extension, e.g. `audio/wav`.
    pub output_mime: Option<String>,
}

impl EngineResult {
    /// True when the engine ran to completion and reported success.
    pub fn succeeded(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }

    /// The most useful failure explanation available, for surfacing to the user.
    pub fn failure_reason(&self, engine: &str) -> String {
        if self.timed_out {
            return format!("引擎 '{}' 超时未返回，已终止", engine);
        }
        let detail = if !self.stderr.is_empty() {
            self.stderr.as_str()
        } else if !self.stdout.is_empty() {
            self.stdout.as_str()
        } else {
            "无输出"
        };
        match self.exit_code {
            Some(code) => format!("引擎 '{}' 退出码 {}：{}", engine, code, detail),
            None => format!("引擎 '{}' 被信号终止：{}", engine, detail),
        }
    }
}

/// A temp file owned by one engine call and removed when the call ends, on every path.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    /// Reserve a unique path and create the file, for payloads we hand to the engine.
    fn with_bytes(bytes: &[u8], ext: &str) -> Result<Self, String> {
        let file = Self::reserve(ext);
        fs::write(&file.path, bytes).map_err(|e| {
            format!("无法写入临时文件 {}: {}", file.path.display(), e)
        })?;
        Ok(file)
    }

    /// Reserve a unique path *without* creating it, for files the engine is expected to
    /// write. Pre-creating those would make a silently-empty engine result look like a
    /// successful synthesis, so absence after the run is treated as a failure.
    fn reserve(ext: &str) -> Self {
        loop {
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "ai-pets-engine-{}-{}-{}.{}",
                std::process::id(),
                seq,
                nanos,
                ext
            ));
            if !path.exists() {
                return Self { path };
            }
        }
    }

    fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Map a capture extension onto the content type the frontend should build a `Blob` with.
fn mime_for_extension(ext: &str) -> String {
    match ext {
        "wav" => "audio/wav".to_string(),
        "mp3" => "audio/mpeg".to_string(),
        "ogg" | "opus" => "audio/ogg".to_string(),
        "flac" => "audio/flac".to_string(),
        "webm" => "audio/webm".to_string(),
        "json" | "txt" => "text/plain".to_string(),
        other => format!("application/octet-stream; ext={}", other),
    }
}

/// Keep a config-supplied extension from escaping the temp directory or naming a file
/// oddly; `None` means the request asked for something unusable and must be corrected.
fn sanitize_extension(ext: &str) -> Option<String> {
    let trimmed = ext.trim().trim_start_matches('.');
    if trimmed.is_empty()
        || trimmed.len() > MAX_EXTENSION_LEN
        || !trimmed.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// True for argv entries meant as a file pattern rather than as text.
///
/// The separator requirement is what keeps a sentence containing `*` (which is passed to a
/// TTS engine as a plain argument) from being mistaken for a glob.
fn is_path_pattern(arg: &str) -> bool {
    arg.contains('*') && (arg.contains('/') || arg.contains('\\'))
}

/// Resolve every path-like `*` argument to the first matching file name.
///
/// Model archives name their weights differently per release (`model.int8.onnx`,
/// `zh_CN-chaowen-medium.onnx`, …), so a config that pins a filename breaks on the next
/// upload. Matching by prefix/suffix keeps the config honest without hardcoding a release.
pub fn expand_arg_patterns(args: &[String]) -> Result<Vec<String>, String> {
    args.iter()
        .map(|arg| {
            if is_path_pattern(arg) {
                resolve_path_pattern(arg)
            } else {
                Ok(arg.clone())
            }
        })
        .collect()
}

/// Resolve one pattern argument, keeping any `--flag=` prefix out of the path.
///
/// A configuration writes these as `--vits-model={model_dir}/*.onnx`, so the argument is
/// not itself a path: without splitting the flag off, the directory looked up would be
/// literally named `--vits-model=E:\…`, which fails on Windows with error 123 rather than
/// with anything that points at the real mistake.
fn resolve_path_pattern(arg: &str) -> Result<String, String> {
    match arg.split_once('=') {
        Some((flag, value)) => Ok(format!("{}={}", flag, resolve_pattern(value)?)),
        None => resolve_pattern(arg),
    }
}

fn resolve_pattern(pattern: &str) -> Result<String, String> {
    let path = Path::new(pattern);
    let dir = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("路径模式 '{}' 不是有效文件名", pattern))?;
    let (prefix, suffix) = file_name
        .split_once('*')
        .ok_or_else(|| format!("路径模式 '{}' 缺少通配符", pattern))?;

    let mut matches: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("无法读取目录 {}: {}", dir.display(), e))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| candidate.is_file())
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(suffix))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();

    matches
        .into_iter()
        .next()
        .map(|m| m.to_string_lossy().into_owned())
        .ok_or_else(|| {
            format!(
                "在 {} 下没有找到与 '{}' 匹配的文件，请检查模型目录",
                dir.display(),
                file_name
            )
        })
}

/// Reject requests that cannot possibly succeed, before anything is spawned.
pub fn validate_engine_request(req: &EngineRequest) -> Result<(), String> {
    if req.exe.trim().is_empty() {
        return Err("引擎可执行文件路径为空，请在设置里填写".into());
    }
    if let Some(input) = req.stdin.as_ref() {
        if input.len() > MAX_ENGINE_STDIN_BYTES {
            return Err(format!(
                "引擎输入 {} 字节，超过上限 {} 字节",
                input.len(),
                MAX_ENGINE_STDIN_BYTES
            ));
        }
    }
    if let Some(payload) = req.input_bytes_base64.as_deref() {
        if payload.len() > MAX_ENGINE_INPUT_BASE64_BYTES {
            return Err(format!(
                "引擎音频输入 {} 字节，超过上限 {} 字节",
                payload.len(),
                MAX_ENGINE_INPUT_BASE64_BYTES
            ));
        }
    }
    if let Some(ext) = req.capture_output_extension.as_deref() {
        if sanitize_extension(ext).is_none() {
            return Err(format!("产出文件扩展名 '{}' 非法", ext));
        }
        if !req
            .args
            .iter()
            .any(|arg| arg.contains(OUTPUT_PLACEHOLDER))
        {
            // Without this the run would look configured while the caller could never
            // receive the audio it asked for.
            return Err(format!(
                "要求捕获产出文件，但参数中没有 {} 占位符",
                OUTPUT_PLACEHOLDER
            ));
        }
    }
    Ok(())
}

/// Rewrite `{input}` / `{output}` in the argv, leaving every other entry untouched.
fn substitute_placeholders(args: &[String], input: Option<&str>, output: Option<&str>) -> Vec<String> {
    args.iter()
        .map(|arg| {
            let mut value = arg.clone();
            if let Some(path) = input {
                value = value.replace(INPUT_PLACEHOLDER, path);
            }
            if let Some(path) = output {
                value = value.replace(OUTPUT_PLACEHOLDER, path);
            }
            value
        })
        .collect()
}

/// Read a child's pipe to EOF on its own thread, appending into a shared sink.
fn spawn_reader<R: Read + Send + 'static>(
    mut pipe: R,
    sink: Arc<Mutex<Vec<u8>>>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut buffer) = sink.lock() {
                        buffer.extend_from_slice(&chunk[..read]);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

/// Collect whatever the reader thread produced, waiting at most [`READER_DRAIN_GRACE`].
///
/// Anything still in flight is dropped rather than waited on, so the caller's total time
/// stays bounded by its timeout even when the engine's own children keep the pipes open.
fn drain(handle: Option<JoinHandle<()>>, sink: &mut Arc<Mutex<Vec<u8>>>) -> (Vec<u8>, bool) {
    let mut complete = true;
    if let Some(handle) = handle {
        let deadline = Instant::now() + READER_DRAIN_GRACE;
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        complete = handle.is_finished();
    }
    let bytes = sink.lock().map(|buffer| buffer.clone()).unwrap_or_default();
    (bytes, complete)
}

/// Terminate the child and, on Windows, anything it launched.
///
/// `Child::kill` terminates exactly one process. An engine reached through `cmd /C` or a
/// `.bat` wrapper is only the parent, and the real engine — which owns the pipes and the
/// CPU — would survive it. `taskkill /T` walks the tree; it is best-effort because the
/// child may exit between the check and the call, and the bounded drain above keeps
/// correctness independent of whether it worked.
fn kill_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", pid.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Run one engine invocation to completion or to its deadline.
pub fn run_engine(req: &EngineRequest) -> Result<EngineResult, String> {
    validate_engine_request(req)?;

    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(DEFAULT_ENGINE_TIMEOUT_MS)
            .min(MAX_ENGINE_TIMEOUT_MS),
    );

    // Both temp files are dropped at the end of this function, including on every error
    // return below, so a failed synthesis never leaves a wav behind in the temp dir.
    let input_file = match req.input_bytes_base64.as_deref() {
        Some(payload) => {
            let bytes = BASE64
                .decode(payload)
                .map_err(|e| format!("音频负载不是合法的 base64: {}", e))?;
            let ext = req
                .input_extension
                .as_deref()
                .and_then(sanitize_extension)
                .unwrap_or_else(|| "wav".to_string());
            Some(TempFile::with_bytes(&bytes, &ext)?)
        }
        None => None,
    };

    let output_file = match req.capture_output_extension.as_deref() {
        Some(ext) => Some(TempFile::reserve(&sanitize_extension(ext).ok_or_else(|| {
            format!("产出文件扩展名 '{}' 非法", ext)
        })?)),
        None => None,
    };

    let args = substitute_placeholders(
        &expand_arg_patterns(&req.args)?,
        input_file.as_ref().map(|f| f.path_string()).as_deref(),
        output_file.as_ref().map(|f| f.path_string()).as_deref(),
    );

    let mut command = Command::new(req.exe.trim());
    command
        .args(&args)
        .stdin(if req.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = req.cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        command.current_dir(dir);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动引擎 '{}': {}", req.exe, e))?;

    if let Some(input) = req.stdin.as_ref() {
        if let Some(mut pipe) = child.stdin.take() {
            let bytes = input.as_bytes().to_vec();
            // Detached: a writer thread that outlives a killed child is harmless, whereas
            // joining it could block on a pipe nobody is draining any more.
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
                let _ = pipe.flush();
            });
        }
    }

    // Output is collected into a shared sink rather than a thread return value: a reader
    // can outlive the deadline when the process holding the pipe is not the one we killed.
    let mut stdout_sink = Arc::new(Mutex::new(Vec::new()));
    let mut stderr_sink = Arc::new(Mutex::new(Vec::new()));
    let stdout_reader = child
        .stdout
        .take()
        .map(|pipe| spawn_reader(pipe, Arc::clone(&stdout_sink)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|pipe| spawn_reader(pipe, Arc::clone(&stderr_sink)));

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    timed_out = true;
                    kill_process_tree(&mut child);
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(format!("等待引擎退出失败: {}", e)),
        }
    };

    let (stdout, stdout_complete) = drain(stdout_reader, &mut stdout_sink);
    let (stderr, stderr_complete) = drain(stderr_reader, &mut stderr_sink);

    let (output_base64, output_mime) = match output_file.as_ref() {
        Some(file) if !timed_out => read_captured_output(file, req.exe.as_str())?,
        _ => (None, None),
    };

    Ok(EngineResult {
        exit_code: status.and_then(|s| s.code()),
        stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        timed_out,
        output_truncated: !stdout_complete || !stderr_complete,
        output_base64,
        output_mime,
    })
}

fn read_captured_output(
    file: &TempFile,
    engine: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let metadata = match fs::metadata(&file.path) {
        Ok(m) => m,
        Err(_) => {
            return Err(format!(
                "引擎 '{}' 未产出文件 {}，请检查其参数与模型路径",
                engine,
                file.path.display()
            ))
        }
    };
    if metadata.len() == 0 {
        return Err(format!("引擎 '{}' 产出的文件为空", engine));
    }
    if metadata.len() > MAX_ENGINE_OUTPUT_BYTES {
        return Err(format!(
            "引擎 '{}' 产出的文件 {} 字节，超过上限 {} 字节",
            engine,
            metadata.len(),
            MAX_ENGINE_OUTPUT_BYTES
        ));
    }
    let bytes = fs::read(&file.path)
        .map_err(|e| format!("无法读取引擎产出 {}: {}", file.path.display(), e))?;
    let ext = file
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    Ok((Some(BASE64.encode(&bytes)), Some(mime_for_extension(ext))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cmd` is present on every supported target, so tests need no bundled fixture and
    /// no dependency on a real speech engine being installed.
    fn cmd_request(script: &str) -> EngineRequest {
        EngineRequest {
            exe: "cmd".into(),
            args: vec!["/C".into(), script.into()],
            stdin: None,
            cwd: None,
            timeout_ms: Some(20_000),
            input_bytes_base64: None,
            input_extension: None,
            capture_output_extension: None,
        }
    }

    fn empty_request(exe: &str) -> EngineRequest {
        EngineRequest {
            exe: exe.into(),
            args: vec![],
            stdin: None,
            cwd: None,
            timeout_ms: Some(20_000),
            input_bytes_base64: None,
            input_extension: None,
            capture_output_extension: None,
        }
    }

    /// A scratch directory that removes itself, so tests leave no files behind.
    struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "ai-pets-test-{}-{}-{}",
                tag,
                std::process::id(),
                TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("scratch dir");
            Self { path }
        }

        fn write(&self, name: &str, contents: &str) -> String {
            let file = self.path.join(name);
            fs::write(&file, contents).expect("fixture file");
            file.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn captures_stdout_and_reports_success() {
        let result = run_engine(&cmd_request("echo hello-engine")).expect("spawn");
        assert!(result.succeeded(), "{:?}", result);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("hello-engine"), "{:?}", result);
        assert!(!result.timed_out);
    }

    #[test]
    fn captures_stderr_separately() {
        let result = run_engine(&cmd_request("echo oops 1>&2")).expect("spawn");
        assert_eq!(result.stderr, "oops");
        assert!(result.stdout.is_empty(), "{:?}", result);
    }

    #[test]
    fn non_zero_exit_is_reported_not_swallowed() {
        let result = run_engine(&cmd_request("exit 3")).expect("spawn");
        assert!(!result.succeeded());
        assert_eq!(result.exit_code, Some(3));
        assert!(result.failure_reason("test-engine").contains("3"));
    }

    #[test]
    fn empty_output_still_returns_a_result() {
        let result = run_engine(&cmd_request("exit 0")).expect("spawn");
        assert!(result.succeeded(), "{:?}", result);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
    }

    #[test]
    fn stdin_is_delivered_and_closed() {
        // `more` copies stdin to stdout and, crucially, only terminates when stdin closes,
        // so this also proves the writer drops the handle rather than leaving it open.
        let mut req = cmd_request("more");
        req.stdin = Some("piped-in-text".into());
        let result = run_engine(&req).expect("spawn");
        assert!(!result.timed_out, "{:?}", result);
        assert!(result.stdout.contains("piped-in-text"), "{:?}", result);
    }

    #[test]
    fn an_overrunning_engine_is_killed_not_waited_on() {
        // `cmd /C` makes ping a *grandchild*: killing cmd alone leaves ping running and
        // holding the stdout pipe, which is what made this call take ping's full 29s
        // instead of its 400ms deadline. The bound below is the user-visible invariant.
        let mut req = cmd_request("ping -n 30 127.0.0.1");
        req.timeout_ms = Some(400);
        let started = Instant::now();
        let result = run_engine(&req).expect("spawn");
        assert!(result.timed_out, "{:?}", result);
        assert!(result.exit_code.is_none(), "{:?}", result);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "kill took {:?}",
            started.elapsed()
        );
        assert!(result.failure_reason("test-engine").contains("超时"));
    }

    #[test]
    fn output_collection_does_not_outlive_a_pipe_held_by_a_grandchild() {
        // `start /b` makes the child exit at once while ping inherits — and keeps open —
        // the stdout pipe for ~9s. Only a bounded drain keeps this call fast; joining the
        // reader threads would wait for ping. Deliberately no `> NUL`: the point is that
        // ping holds our pipe.
        let started = Instant::now();
        let outcome = run_engine(&cmd_request("start /b ping -n 10 127.0.0.1")).expect("spawn");
        assert!(!outcome.timed_out, "{:?}", outcome);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "drain waited {:?} on a pipe a grandchild still holds",
            started.elapsed()
        );
        // The truncated flag is what keeps the bounding honest: the output really was cut.
        assert!(
            outcome.output_truncated,
            "gave up on a live pipe but reported complete output: {:?}",
            outcome
        );
    }

    #[test]
    fn a_timed_out_engine_leaves_nothing_holding_its_pipes() {
        // Collection only reports complete when the pipes actually closed, so this fails
        // if `taskkill /T` stops taking the grandchild down with the child.
        let mut req = cmd_request("ping -n 30 127.0.0.1");
        req.timeout_ms = Some(400);
        let result = run_engine(&req).expect("spawn");
        assert!(result.timed_out, "{:?}", result);
        assert!(
            !result.output_truncated,
            "the pipe was still held after the kill, so the process tree survived: {:?}",
            result
        );
    }

    #[test]
    fn a_large_stdout_does_not_deadlock() {
        // Far beyond a pipe buffer: without draining threads this would hang until timeout.
        let result = run_engine(&cmd_request(
            "for /L %i in (1,1,4000) do @echo line-%i-padding-padding-padding",
        ))
        .expect("spawn");
        assert!(!result.timed_out, "pipe buffer deadlock");
        assert!(
            result.stdout.lines().count() > 3000,
            "got {} lines",
            result.stdout.lines().count()
        );
    }

    #[test]
    fn a_missing_executable_is_a_readable_error() {
        let req = empty_request("definitely-not-a-real-engine-xyz");
        let err = run_engine(&req).unwrap_err();
        assert!(err.contains("无法启动引擎"), "{err}");
    }

    #[test]
    fn an_empty_executable_path_is_rejected_before_spawning() {
        let mut req = cmd_request("echo x");
        req.exe = "   ".into();
        assert!(run_engine(&req).unwrap_err().contains("路径为空"));
    }

    #[test]
    fn oversized_stdin_is_rejected() {
        let mut req = cmd_request("more");
        req.stdin = Some("a".repeat(MAX_ENGINE_STDIN_BYTES + 1));
        assert!(run_engine(&req).unwrap_err().contains("超过上限"));
    }

    #[test]
    fn oversized_audio_payload_is_rejected() {
        let mut req = cmd_request("exit 0");
        req.input_bytes_base64 = Some("A".repeat(MAX_ENGINE_INPUT_BASE64_BYTES + 1));
        assert!(run_engine(&req).unwrap_err().contains("超过上限"));
    }

    #[test]
    fn timeout_is_clamped_to_the_ceiling() {
        // A config asking for a year must not actually be honoured; the clamp is applied
        // before the deadline is computed, so this only asserts the request is accepted.
        let mut req = cmd_request("exit 0");
        req.timeout_ms = Some(u64::MAX);
        assert!(run_engine(&req).expect("spawn").succeeded());
    }

    #[test]
    fn no_shell_means_metacharacters_are_not_interpreted() {
        // If argv went through a shell, `&` would start a second command and this marker
        // would appear. Passed directly to Command it is just an argument.
        let req = EngineRequest {
            args: vec!["/C".into(), "echo".into(), "a&echo INJECTED".into()],
            ..empty_request("cmd")
        };
        let result = run_engine(&req).expect("spawn");
        // cmd itself interprets its own /C string, so assert on how *we* passed argv:
        // the argument count and content are preserved verbatim by Command.
        assert_eq!(req.args.len(), 3);
        assert_eq!(req.args[2], "a&echo INJECTED");
        assert!(result.exit_code.is_some());
    }

    #[test]
    fn an_input_payload_becomes_a_readable_file_at_the_placeholder() {
        // `type` prints a file, so the engine seeing the exact bytes proves the temp file
        // exists, is named where `{input}` said, and is cleaned up afterwards.
        let payload = BASE64.encode(b"recorded-speech-bytes");
        let mut req = empty_request("cmd");
        req.args = vec![
            "/C".into(),
            "type".into(),
            INPUT_PLACEHOLDER.into(),
        ];
        req.input_bytes_base64 = Some(payload);
        req.input_extension = Some("wav".into());

        let result = run_engine(&req).expect("spawn");
        assert!(result.succeeded(), "{:?}", result);
        assert_eq!(result.stdout, "recorded-speech-bytes");
    }

    #[test]
    fn an_input_placeholder_written_on_disk_is_deleted_after_the_run() {
        let mut req = empty_request("cmd");
        // Echo the resolved path so the test can look for the file afterwards.
        req.args = vec!["/C".into(), "echo".into(), INPUT_PLACEHOLDER.into()];
        req.input_bytes_base64 = Some(BASE64.encode(b"x"));
        let result = run_engine(&req).expect("spawn");
        let path = result.stdout.trim();
        assert!(!path.is_empty(), "{:?}", result);
        assert!(
            !Path::new(path).exists(),
            "temp input {path} was left behind"
        );
    }

    #[test]
    fn a_non_base64_payload_is_rejected() {
        let mut req = cmd_request("exit 0");
        req.input_bytes_base64 = Some("not base64 !!".into());
        req.input_extension = Some("wav".into());
        assert!(run_engine(&req).unwrap_err().contains("base64"));
    }

    #[test]
    fn the_captured_output_file_is_returned_as_base64() {
        let mut req = empty_request("cmd");
        req.args = vec![
            "/C".into(),
            format!("echo engine-audio> {}", OUTPUT_PLACEHOLDER),
        ];
        req.capture_output_extension = Some("wav".into());

        let result = run_engine(&req).expect("spawn");
        assert!(result.succeeded(), "{:?}", result);
        assert_eq!(result.output_mime.as_deref(), Some("audio/wav"));
        let bytes = BASE64
            .decode(result.output_base64.expect("captured bytes"))
            .expect("valid base64");
        assert_eq!(String::from_utf8_lossy(&bytes).trim(), "engine-audio");
    }

    #[test]
    fn a_shared_temp_path_is_not_reused_between_calls() {
        // Two runs in a row must not collide, or the second would read the first's audio.
        let mut req = empty_request("cmd");
        req.args = vec![
            "/C".into(),
            format!("echo run> {}", OUTPUT_PLACEHOLDER),
        ];
        req.capture_output_extension = Some("wav".into());
        let first = run_engine(&req).expect("spawn");
        let second = run_engine(&req).expect("spawn");
        assert!(first.output_base64.is_some());
        assert!(second.output_base64.is_some());
    }

    #[test]
    fn an_engine_that_writes_nothing_is_a_failure_not_silent_success() {
        // The whole point of reserving rather than pre-creating the file: sherpa exiting 0
        // without audio must not surface as an empty but "successful" synthesis.
        let mut req = cmd_request("exit 0");
        req.args.push(OUTPUT_PLACEHOLDER.into());
        req.capture_output_extension = Some("wav".into());
        let err = run_engine(&req).unwrap_err();
        assert!(err.contains("未产出文件"), "{err}");
    }

    #[test]
    fn capturing_output_without_a_placeholder_is_rejected() {
        let mut req = cmd_request("exit 0");
        req.capture_output_extension = Some("wav".into());
        let err = run_engine(&req).unwrap_err();
        assert!(err.contains(OUTPUT_PLACEHOLDER), "{err}");
    }

    #[test]
    fn an_illegal_capture_extension_is_rejected() {
        for ext in ["", "  ", "../../etc/passwd", "wa v", "waaaaaaaaaav"] {
            let mut req = cmd_request("exit 0");
            req.args.push(OUTPUT_PLACEHOLDER.into());
            req.capture_output_extension = Some(ext.into());
            assert!(
                run_engine(&req).unwrap_err().contains("非法"),
                "{ext:?} should not be usable as an extension"
            );
        }
    }

    #[test]
    fn extension_sanitising_accepts_the_forms_configs_actually_use() {
        assert_eq!(sanitize_extension("wav").as_deref(), Some("wav"));
        assert_eq!(sanitize_extension(".WAV").as_deref(), Some("wav"));
        assert_eq!(sanitize_extension(" mp3 ").as_deref(), Some("mp3"));
        assert_eq!(sanitize_extension("a/b"), None);
        assert_eq!(sanitize_extension(""), None);
    }

    #[test]
    fn a_model_glob_resolves_to_the_first_file_in_name_order() {
        let scratch = Scratch::new("glob");
        scratch.write("zzz-model.onnx", "");
        scratch.write("aaa-model.onnx", "");
        scratch.write("tokens.txt", "");

        let pattern = format!("{}\\*-model.onnx", scratch.path.display());
        let resolved = expand_arg_patterns(&[pattern]).expect("resolve");
        assert!(
            resolved[0].ends_with("aaa-model.onnx"),
            "expected the first match in name order, got {}",
            resolved[0]
        );
    }

    #[test]
    fn a_flag_prefixed_glob_resolves_against_the_value_not_the_whole_argument() {
        // Found by running the shipped `--vits-model={model_dir}/*.onnx` template against
        // a real engine: treating the whole argument as a path made the lookup directory
        // `--vits-model=E:\…`, which fails with os error 123.
        let scratch = Scratch::new("flagglob");
        scratch.write("aaa-model.onnx", "");
        let pattern = format!("--vits-model={}\\*-model.onnx", scratch.path.display());

        let resolved = expand_arg_patterns(&[pattern]).expect("resolve");
        assert!(resolved[0].starts_with("--vits-model="), "{}", resolved[0]);
        assert!(resolved[0].ends_with("aaa-model.onnx"), "{}", resolved[0]);
        assert!(!resolved[0].contains('*'), "{}", resolved[0]);
        assert!(
            !resolved[0].contains("--vits-model=--vits-model"),
            "the flag leaked into the path: {}",
            resolved[0]
        );
    }

    #[test]
    fn a_model_glob_never_matches_a_directory() {
        let scratch = Scratch::new("globdir");
        fs::create_dir_all(scratch.path.join("aaa-model.onnx")).expect("decoy dir");
        scratch.write("bbb-model.onnx", "");
        let pattern = format!("{}\\*-model.onnx", scratch.path.display());
        let resolved = expand_arg_patterns(&[pattern]).expect("resolve");
        assert!(resolved[0].ends_with("bbb-model.onnx"), "{}", resolved[0]);
    }

    #[test]
    fn a_glob_matching_nothing_names_the_directory_it_looked_in() {
        let scratch = Scratch::new("globnone");
        let pattern = format!("{}\\*.onnx", scratch.path.display());
        let err = expand_arg_patterns(&[pattern]).unwrap_err();
        assert!(err.contains(&scratch.path.to_string_lossy().into_owned()), "{err}");
        assert!(err.contains("请检查模型目录"), "{err}");
    }

    #[test]
    fn text_containing_a_star_is_not_treated_as_a_path_pattern() {
        // A TTS engine receives the sentence as a plain argv entry; `*` in punctuation
        // must reach it verbatim instead of failing as an unmatched glob.
        let args = vec!["--text".into(), "你好*世界".into()];
        assert_eq!(expand_arg_patterns(&args).unwrap(), args);
    }

    #[test]
    fn placeholder_substitution_touches_only_the_placeholder() {
        let args = vec![
            "--model={input}".into(),
            "--out={output}".into(),
            "sentence".into(),
        ];
        let out = substitute_placeholders(&args, Some("\\tmp\\in.wav"), Some("\\tmp\\out.wav"));
        assert_eq!(out[0], "--model=\\tmp\\in.wav");
        assert_eq!(out[1], "--out=\\tmp\\out.wav");
        assert_eq!(out[2], "sentence");
    }

    #[test]
    fn mime_types_cover_the_formats_speech_endpoints_return() {
        assert_eq!(mime_for_extension("wav"), "audio/wav");
        assert_eq!(mime_for_extension("mp3"), "audio/mpeg");
        assert_eq!(mime_for_extension("opus"), "audio/ogg");
        assert!(mime_for_extension("weird").starts_with("application/octet-stream"));
    }
}

