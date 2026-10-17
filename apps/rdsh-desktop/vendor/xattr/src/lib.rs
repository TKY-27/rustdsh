//! Minimal `xattr` 0.2-compatible shim.
//!
//! The published `xattr` 0.2.3 fails to compile on current Linux toolchains
//! (`libc::ENOATTR` no longer exists there) and an 0.2-compatible release with
//! the fix is not published. `zed-async-tar` (used by `gpui_http_client`) calls
//! `xattr::set` only, so this crate implements the 0.2 API surface directly on
//! top of the platform syscalls.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::Path;

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    fn cstr(value: &OsStr) -> io::Result<std::ffi::CString> {
        std::ffi::CString::new(value.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "interior NUL byte"))
    }

    pub fn get(path: &Path, name: &OsStr) -> io::Result<Vec<u8>> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        unsafe {
            let size = libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0);
            if size < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u8; size as usize];
            let written = libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr() as *mut libc::c_void,
                buffer.len(),
            );
            if written < 0 {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(written as usize);
            Ok(buffer)
        }
    }

    pub fn set(path: &Path, name: &OsStr, value: &[u8]) -> io::Result<()> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        let rc = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr() as *const libc::c_void,
                value.len(),
                0,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn remove(path: &Path, name: &OsStr) -> io::Result<()> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        let rc = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr()) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn list(path: &Path) -> io::Result<Vec<OsString>> {
        let path = cstr(path.as_os_str())?;
        unsafe {
            let size = libc::listxattr(path.as_ptr(), std::ptr::null_mut(), 0);
            if size < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u8; size as usize];
            let written = libc::listxattr(
                path.as_ptr(),
                buffer.as_mut_ptr() as *mut libc::c_char,
                buffer.len(),
            );
            if written < 0 {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(written as usize);
            Ok(buffer
                .split(|byte| *byte == 0)
                .filter(|name| !name.is_empty())
                .map(|name| OsString::from_vec(name.to_vec()))
                .collect())
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    fn cstr(value: &OsStr) -> io::Result<std::ffi::CString> {
        std::ffi::CString::new(value.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "interior NUL byte"))
    }

    pub fn get(path: &Path, name: &OsStr) -> io::Result<Vec<u8>> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        unsafe {
            let size = libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0);
            if size < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u8; size as usize];
            let written = libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr() as *mut libc::c_void,
                buffer.len(),
                0,
                0,
            );
            if written < 0 {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(written as usize);
            Ok(buffer)
        }
    }

    pub fn set(path: &Path, name: &OsStr, value: &[u8]) -> io::Result<()> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        let rc = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr() as *const libc::c_void,
                value.len(),
                0,
                0,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn remove(path: &Path, name: &OsStr) -> io::Result<()> {
        let path = cstr(path.as_os_str())?;
        let name = cstr(name)?;
        let rc = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr(), 0) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn list(path: &Path) -> io::Result<Vec<OsString>> {
        let path = cstr(path.as_os_str())?;
        unsafe {
            let size = libc::listxattr(path.as_ptr(), std::ptr::null_mut(), 0, 0);
            if size < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u8; size as usize];
            let written = libc::listxattr(path.as_ptr(), buffer.as_mut_ptr() as *mut libc::c_char, buffer.len(), 0);
            if written < 0 {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(written as usize);
            Ok(buffer
                .split(|byte| *byte == 0)
                .filter(|name| !name.is_empty())
                .map(|name| OsString::from(std::ffi::OsStr::from_bytes(name)))
                .collect())
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::*;

    fn unsupported() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, "extended attributes are not supported on this platform")
    }

    pub fn get(_path: &Path, _name: &OsStr) -> io::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub fn set(_path: &Path, _name: &OsStr, _value: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn remove(_path: &Path, _name: &OsStr) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn list(_path: &Path) -> io::Result<Vec<OsString>> {
        Err(unsupported())
    }
}

pub fn get<P: AsRef<Path>, N: AsRef<OsStr>>(path: P, name: N) -> io::Result<Vec<u8>> {
    imp::get(path.as_ref(), name.as_ref())
}

pub fn set<P: AsRef<Path>, N: AsRef<OsStr>>(path: P, name: N, value: &[u8]) -> io::Result<()> {
    imp::set(path.as_ref(), name.as_ref(), value)
}

pub fn remove<P: AsRef<Path>, N: AsRef<OsStr>>(path: P, name: N) -> io::Result<()> {
    imp::remove(path.as_ref(), name.as_ref())
}

pub fn list<P: AsRef<Path>>(path: P) -> io::Result<Vec<OsString>> {
    imp::list(path.as_ref())
}
