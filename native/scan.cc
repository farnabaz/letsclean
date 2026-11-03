// getattrlistbulk lists a directory and returns name, type and allocated size
// in one syscall per batch. That replaces readdir plus one lstat per file.

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/syslimits.h>
#include <sys/vnode.h>
#include <unistd.h>

#include <node_api.h>

static const uint32_t kAttrBuf = 256 * 1024;

typedef struct {
  int fd;
  char *buf;
} Scan;

static const char *ErrnoName(int err) {
  switch (err) {
  case EACCES:
    return "EACCES";
  case EPERM:
    return "EPERM";
  case ENOENT:
    return "ENOENT";
  case ENOTDIR:
    return "ENOTDIR";
  case ENAMETOOLONG:
    return "ENAMETOOLONG";
  case ELOOP:
    return "ELOOP";
  case EIO:
    return "EIO";
  default:
    return "EIO";
  }
}

static void ThrowErrno(napi_env env, int err) {
  const char *code = ErrnoName(err);
  const char *message = strerror(err);
  napi_value js_code;
  napi_value js_message;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &js_code);
  napi_create_string_utf8(env, message ? message : code, NAPI_AUTO_LENGTH,
                          &js_message);
  napi_value error;
  napi_create_error(env, js_code, js_message, &error);
  napi_throw(env, error);
}

static void FinalizeScan(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  Scan *scan = (Scan *)data;
  if (!scan)
    return;
  if (scan->fd >= 0)
    close(scan->fd);
  free(scan->buf);
  free(scan);
}

static void FinalizeFree(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  free(data);
}

static Scan *Unwrap(napi_env env, napi_value value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external)
    return NULL;
  Scan *scan = NULL;
  if (napi_get_value_external(env, value, (void **)&scan) != napi_ok)
    return NULL;
  if (!scan || scan->fd < 0)
    return NULL;
  return scan;
}

static napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv;
  napi_get_cb_info(env, info, &argc, &argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "path required");
    return NULL;
  }

  char path[PATH_MAX];
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv, path, sizeof(path), &len) !=
      napi_ok)
    return NULL;
  if (len == 0 || len >= sizeof(path) - 1) {
    ThrowErrno(env, ENAMETOOLONG);
    return NULL;
  }

  int fd = open(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0) {
    ThrowErrno(env, errno);
    return NULL;
  }

  Scan *scan = (Scan *)calloc(1, sizeof(Scan));
  if (!scan) {
    close(fd);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  scan->fd = fd;
  scan->buf = (char *)malloc(kAttrBuf);
  if (!scan->buf) {
    close(fd);
    free(scan);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }

  napi_value external;
  napi_create_external(env, scan, FinalizeScan, NULL, &external);
  return external;
}

// read(handle) -> { names: string[], kinds: Uint8Array, sizes: Float64Array,
// done: boolean } kinds: 1 directory, 2 symlink, 8 unreadable. Directories
// report size 0.
static napi_value Read(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv;
  napi_get_cb_info(env, info, &argc, &argv, NULL, NULL);
  Scan *scan = Unwrap(env, argv);
  if (!scan) {
    napi_throw_type_error(env, NULL, "bad scan handle");
    return NULL;
  }

  struct attrlist attr;
  memset(&attr, 0, sizeof(attr));
  attr.bitmapcount = ATTR_BIT_MAP_COUNT;
  attr.commonattr = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR | ATTR_CMN_NAME |
                    ATTR_CMN_OBJTYPE;
  attr.fileattr = ATTR_FILE_ALLOCSIZE;

  int count = getattrlistbulk(scan->fd, &attr, scan->buf, kAttrBuf,
                              FSOPT_NOFOLLOW | FSOPT_PACK_INVAL_ATTRS);
  if (count < 0) {
    ThrowErrno(env, errno);
    return NULL;
  }

  napi_value result;
  napi_create_object(env, &result);
  napi_value done;
  napi_get_boolean(env, count == 0, &done);
  napi_set_named_property(env, result, "done", done);

  napi_value names;
  napi_create_array_with_length(env, (size_t)count, &names);
  napi_set_named_property(env, result, "names", names);
  if (count == 0)
    return result;

  uint8_t *kinds = (uint8_t *)calloc((size_t)count, 1);
  double *sizes = (double *)calloc((size_t)count, sizeof(double));
  if (!kinds || !sizes) {
    free(kinds);
    free(sizes);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }

  char *cursor = scan->buf;
  char *end = scan->buf + kAttrBuf;
  for (int i = 0; i < count; i++) {
    if (cursor + sizeof(uint32_t) > end)
      break;
    uint32_t rec_len = *(uint32_t *)cursor;
    if (rec_len < sizeof(uint32_t) || cursor + rec_len > end)
      break;

    char *field = cursor + sizeof(uint32_t);
    char *rec_end = cursor + rec_len;

    attribute_set_t returned;
    memset(&returned, 0, sizeof(returned));
    if (field + sizeof(returned) <= rec_end) {
      memcpy(&returned, field, sizeof(returned));
      field += sizeof(returned);
    }

    int32_t rec_error = 0;
    if ((returned.commonattr & ATTR_CMN_ERROR) &&
        field + sizeof(rec_error) <= rec_end) {
      memcpy(&rec_error, field, sizeof(rec_error));
      field += sizeof(rec_error);
    }

    uint8_t kind = 0;
    double size = 0;

    if ((returned.commonattr & ATTR_CMN_NAME) &&
        field + sizeof(attrreference_t) <= rec_end) {
      attrreference_t ref;
      memcpy(&ref, field, sizeof(ref));
      const char *name = (const char *)field + ref.attr_dataoffset;
      if (name < (const char *)field || name >= (const char *)rec_end)
        name = "";
      napi_value js_name;
      napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &js_name);
      napi_set_element(env, names, (uint32_t)i, js_name);
      field += sizeof(attrreference_t);
    } else {
      napi_value js_name;
      napi_create_string_utf8(env, "", 0, &js_name);
      napi_set_element(env, names, (uint32_t)i, js_name);
    }

    if ((returned.commonattr & ATTR_CMN_OBJTYPE) &&
        field + sizeof(fsobj_type_t) <= rec_end) {
      fsobj_type_t type = 0;
      memcpy(&type, field, sizeof(type));
      if (type == VDIR)
        kind = 1;
      else if (type == VLNK)
        kind = 2;
      field += sizeof(fsobj_type_t);
    }

    if ((returned.fileattr & ATTR_FILE_ALLOCSIZE) &&
        field + sizeof(uint64_t) <= rec_end) {
      uint64_t alloc = 0;
      memcpy(&alloc, field, sizeof(alloc));
      size = (double)alloc;
    }

    if (rec_error != 0 && rec_error != ENOATTR)
      kind = (uint8_t)(kind | 8);
    kinds[i] = kind;
    sizes[i] = size;
    cursor += rec_len;
  }

  napi_value kinds_buf;
  napi_create_external_arraybuffer(env, kinds, (size_t)count, FinalizeFree,
                                   NULL, &kinds_buf);
  napi_value kinds_arr;
  napi_create_typedarray(env, napi_uint8_array, (size_t)count, kinds_buf, 0,
                         &kinds_arr);

  napi_value sizes_buf;
  napi_create_external_arraybuffer(env, sizes, (size_t)count * sizeof(double),
                                   FinalizeFree, NULL, &sizes_buf);
  napi_value sizes_arr;
  napi_create_typedarray(env, napi_float64_array, (size_t)count, sizes_buf, 0,
                         &sizes_arr);

  napi_set_named_property(env, result, "kinds", kinds_arr);
  napi_set_named_property(env, result, "sizes", sizes_arr);
  return result;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv;
  napi_get_cb_info(env, info, &argc, &argv, NULL, NULL);
  Scan *scan = Unwrap(env, argv);
  if (scan && scan->fd >= 0) {
    close(scan->fd);
    scan->fd = -1;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value open_fn;
  napi_value read_fn;
  napi_value close_fn;
  napi_create_function(env, "open", NAPI_AUTO_LENGTH, Open, NULL, &open_fn);
  napi_create_function(env, "read", NAPI_AUTO_LENGTH, Read, NULL, &read_fn);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, NULL, &close_fn);
  napi_set_named_property(env, exports, "open", open_fn);
  napi_set_named_property(env, exports, "read", read_fn);
  napi_set_named_property(env, exports, "close", close_fn);
  return exports;
}

NAPI_MODULE_INIT() { return Init(env, exports); }
