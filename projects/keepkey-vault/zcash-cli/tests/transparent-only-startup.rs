// Starts only the isolated sidecar with EOF stdin. No command can reach a node,
// device or real user profile; --transparent-only must not hydrate a private wallet.
#[test]
fn transparent_startup_does_not_open_wallet_storage_or_export_fvk() {
    let profile = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-cli"))
        .arg("--transparent-only")
        .env("HOME", profile.path())
        .env("XDG_DATA_HOME", profile.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ready: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ready["ready"], true);
    assert_eq!(ready["fvk_loaded"], false);
    assert_eq!(ready["transparent_only"], true);
    assert_eq!(
        ready["transparent_capability"],
        "keepkey-zcash-cli:nu7-transparent:v1"
    );
    assert!(ready.get("fvk").is_none());
    assert!(ready["synced_to"].is_null());
    assert_eq!(std::fs::read_dir(profile.path()).unwrap().count(), 0);
}

#[test]
fn explicitly_started_profile_advertises_the_same_transparent_capability() {
    let profile = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-cli"))
        .env("HOME", profile.path())
        .env("XDG_DATA_HOME", profile.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ready: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ready["ready"], true);
    assert_eq!(
        ready["transparent_capability"],
        "keepkey-zcash-cli:nu7-transparent:v1"
    );
    assert_eq!(ready["transparent_only"], false);
    assert_eq!(ready["fvk_loaded"], false);
    assert!(ready.get("fvk").is_none());
    // This was the explicitly requested profile mode; its original lazy DB
    // startup remains confined to this fresh synthetic HOME.
    assert!(profile.path().join(".keepkey/zcash_wallet.db").is_file());
}

#[test]
fn native_child_rejects_background_private_commands_and_stays_usable_without_storage() {
    use std::io::Write;
    let profile = tempfile::tempdir().unwrap();
    // These exact empty requests are also network-free before the mode guard:
    // balance/history touch only the disposable profile, and the FVK/scan calls
    // fail for missing data. Network-capable command admission is tested purely.
    let private_commands = [
        "balance",
        "get_transactions",
        "get_scan_status",
        "derive_fvk",
        "set_fvk",
        "scan",
    ];
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_zcash-cli"))
        .arg("--transparent-only")
        .env("HOME", profile.path())
        .env("XDG_DATA_HOME", profile.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for (i, command) in private_commands.iter().enumerate() {
            writeln!(
                stdin,
                "{}",
                serde_json::json!({ "cmd": command, "_req_id": i + 1 })
            )
            .unwrap();
        }
        // Both admitted native commands fail locally with missing draft data,
        // without invoking lightwalletd, then ping proves the child survived.
        for (i, command) in ["build_transparent_pczt", "finalize_transparent", "ping"]
            .iter()
            .enumerate()
        {
            writeln!(
                stdin,
                "{}",
                serde_json::json!({ "cmd": command, "_req_id": private_commands.len() + i + 1 })
            )
            .unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 1 + private_commands.len() + 3);
    for (i, response) in responses
        .iter()
        .skip(1)
        .take(private_commands.len())
        .enumerate()
    {
        assert_eq!(response["_req_id"], i + 1);
        assert_eq!(
            response["ok"], false,
            "{} must not read a profile",
            private_commands[i]
        );
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("transparent-only mode"));
        assert!(response.get("fvk").is_none());
    }
    assert!(responses[1 + private_commands.len()]["error"]
        .as_str()
        .unwrap()
        .contains("transparent_inputs"));
    assert!(responses[2 + private_commands.len()]["error"]
        .as_str()
        .unwrap()
        .contains("request_id"));
    assert_eq!(responses.last().unwrap()["pong"], true);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Trying lightwalletd"));
    assert_eq!(std::fs::read_dir(profile.path()).unwrap().count(), 0);
}
