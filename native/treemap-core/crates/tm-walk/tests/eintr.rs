//! `retry_eintr`: a system call a signal interrupted is made again, and
//! nothing else is. A signal that lands while a worker is inside `open`,
//! `getattrlistbulk`, `getdents64`, `statx` or `fstatat` says nothing about
//! the file; without the retry a readable directory would be recorded as
//! unreadable, its subtree dropped, because of when a signal arrived (the
//! pre-CI review of 23 September 2026).
#![cfg(unix)]

use tm_walk::platform::retry_eintr;

#[test]
fn an_interrupted_call_is_made_again_and_its_answer_returned() {
    let mut calls = 0;
    let result = retry_eintr(|| {
        calls += 1;
        if calls < 3 { Err(libc::EINTR) } else { Ok(7) }
    });
    assert_eq!(result, Ok(7));
    assert_eq!(calls, 3, "two interruptions, then the answer");
}

#[test]
fn any_other_error_is_returned_at_once() {
    for errno in [
        libc::EACCES,
        libc::EPERM,
        libc::ENOENT,
        libc::ENOTDIR,
        libc::EIO,
        libc::EAGAIN,
    ] {
        let mut calls = 0;
        let result: Result<(), i32> = retry_eintr(|| {
            calls += 1;
            Err(errno)
        });
        assert_eq!(result, Err(errno));
        assert_eq!(calls, 1, "errno {errno} is an answer, not an interruption");
    }
}

#[test]
fn a_success_is_returned_at_once() {
    let mut calls = 0;
    let result: Result<&str, i32> = retry_eintr(|| {
        calls += 1;
        Ok("listed")
    });
    assert_eq!(result, Ok("listed"));
    assert_eq!(calls, 1);
}
