"""Windows Credential Manager backing for the evaluation refresh token.

DPAPI-encrypted, per-user, survives reboots. Standard library only
(ctypes -> advapi32); no installs, no services, no network. Secret-free
code: values only ever live in caller memory and are never printed here.
Non-Windows or unavailable API -> silent empty results (env/CLI path still
works).
"""

import ctypes
import os

TARGET = "RAG4I_eval_refresh_token"
USERNAME = "rag4i-eval"

CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2


class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_uint32),
        ("dwHighDateTime", ctypes.c_uint32),
    ]


class _CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", ctypes.c_uint32),
        ("Type", ctypes.c_uint32),
        ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p),
        ("LastWritten", _FILETIME),
        ("CredentialBlobSize", ctypes.c_uint32),
        ("CredentialBlob", ctypes.c_void_p),
        ("Persist", ctypes.c_uint32),
        ("AttributeCount", ctypes.c_uint32),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


def _advapi():
    if os.name != "nt":
        return None
    try:
        adv = ctypes.windll.advapi32
        adv.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32,
                                  ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
        adv.CredReadW.restype = ctypes.c_bool
        adv.CredWriteW.argtypes = [ctypes.POINTER(_CREDENTIAL), ctypes.c_uint32]
        adv.CredWriteW.restype = ctypes.c_bool
        adv.CredDeleteW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32,
                                    ctypes.c_uint32]
        adv.CredDeleteW.restype = ctypes.c_bool
        adv.CredFree.argtypes = [ctypes.c_void_p]
        adv.CredFree.restype = None
        return adv
    except Exception:
        return None


def read_refresh_token(target=TARGET):
    """Return the stored secret, or '' when absent/unavailable. Never raises,
    never prints."""
    adv = _advapi()
    if adv is None:
        return ""
    try:
        out = ctypes.c_void_p()
        ok = adv.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(out))
        if not ok or not out.value:
            return ""
        try:
            cred = ctypes.cast(out.value, ctypes.POINTER(_CREDENTIAL)).contents
            size = int(cred.CredentialBlobSize)
            if not size or not cred.CredentialBlob:
                return ""
            return ctypes.string_at(cred.CredentialBlob, size).decode("utf-8")
        finally:
            adv.CredFree(out.value)
    except Exception:
        return ""


def write_refresh_token(secret, target=TARGET):
    """Store the secret. Returns True on success. Never prints the secret."""
    adv = _advapi()
    if adv is None or not secret:
        return False
    try:
        blob = secret.encode("utf-8")
        buf = ctypes.create_string_buffer(blob)
        cred = _CREDENTIAL()
        cred.Flags = 0
        cred.Type = CRED_TYPE_GENERIC
        cred.TargetName = target
        cred.Comment = None
        cred.CredentialBlobSize = len(blob)
        cred.CredentialBlob = ctypes.cast(buf, ctypes.c_void_p).value
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE
        cred.AttributeCount = 0
        cred.Attributes = None
        cred.TargetAlias = None
        cred.UserName = USERNAME
        return bool(adv.CredWriteW(ctypes.byref(cred), 0))
    except Exception:
        return False


def delete_refresh_token(target=TARGET):
    """Remove the stored secret. Returns True when gone. Never prints."""
    adv = _advapi()
    if adv is None:
        return False
    try:
        return bool(adv.CredDeleteW(target, CRED_TYPE_GENERIC, 0))
    except Exception:
        return False
