import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
  VirtualizedList,
  SafeAreaView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

const USERNAME = "zellarun";

// Required load/save endpoints
const LOAD_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/loadjson.php?user=${USERNAME}`;
const SAVE_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/savejson.php?user=${USERNAME}`;

// Extra credit endpoints (proxy cache)
const SIZE_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/listsize.php?user=${USERNAME}`;
const ELEMENT_URL = (i: number) =>
  `https://mec402.boisestate.edu/csclasses/cs402/codesnips/getelement.php?user=${USERNAME}&item=${i}`;

// Types
type ListItem = { id: string; text: string };

// Server format we’ve observed: { items: string[] }
function normalizeRemoteData(raw: any): ListItem[] {
  if (!raw || !Array.isArray(raw.items)) return [];
  return raw.items.map((text: string, index: number) => ({
    id: `${Date.now()}-${index}`,
    text: String(text),
  }));
}

// Safely get JSON from endpoints that sometimes return plain text
async function fetchText(url: string) {
  const res = await fetch(url);
  const text = await res.text();
  return { res, text };
}

// Main App
export default function App() {
  // Basic UI state
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(true); // initial load
  const [busy, setBusy] = useState(false);      // buttons / background fetch
  const [useCacheMode, setUseCacheMode] = useState(true); // extra credit toggle

  // listSize: total number of items on server
  const [listSize, setListSize] = useState<number>(0);

  // cache: index -> text
  const [cache, setCache] = useState<Map<number, string>>(new Map());

  // inFlight: track which indices are currently being fetched (prevents spam)
  const inFlightRef = useRef<Set<number>>(new Set());

  // indices array for VirtualizedList data
  const indices = useMemo(() => Array.from({ length: listSize }, (_, i) => i), [listSize]);

  // localItems: used in normal mode (not cache mode)
  const [localItems, setLocalItems] = useState<ListItem[]>([
    { id: "1", text: "Buy groceries" },
    { id: "2", text: "Walk the dog" },
    { id: "3", text: "Read a book" },
  ]);

  // load list size from server (extra credit)
  const loadListSize = useCallback(async () => {
    const { res, text } = await fetchText(SIZE_URL);
    console.log("SIZE raw:", text);

    if (!res.ok) throw new Error(`Size HTTP ${res.status}`);

    let size = 0;

    // Try JSON first
    try {
      const json = JSON.parse(text);
      if (typeof json === "number") size = json;
      else if (typeof json?.size === "number") size = json.size;
      else if (typeof json?.count === "number") size = json.count;
      else size = Number(text);
    } catch {
      size = Number(text);
    }

    if (!Number.isFinite(size) || size < 0) size = 0;
    setListSize(size);
    return size;
  }, []);

  // fetch element by index and store in cache (extra credit)
  const fetchElement = useCallback(async (index: number) => {
    if (cache.has(index)) return; // already cached
    if (inFlightRef.current.has(index)) return; // already fetching

    inFlightRef.current.add(index);

    try {
      const { res, text } = await fetchText(ELEMENT_URL(index));
      // element might be JSON or plain text
      if (!res.ok) throw new Error(`Element HTTP ${res.status}`);

      let value: any = text;

      // Try JSON parse; if it fails, treat as plain text
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }

      // Extract text from value (handles both string and { key/text/value } formats)
      const itemText =
        typeof value === "string"
          ? value
          : value?.text ?? value?.key ?? value?.value ?? JSON.stringify(value);

      setCache((prev) => {
        const next = new Map(prev);
        next.set(index, String(itemText));
        return next;
      });
    } catch (e: any) {
      console.log("fetchElement error:", e?.message ?? e);
    } finally {
      inFlightRef.current.delete(index);
    }
  }, [cache]);

  // Cache mode initialization: load list size, then warm up first few items for better UX
  const initCacheMode = useCallback(async () => {
    try {
      setLoading(true);
      setCache(new Map());
      inFlightRef.current.clear();

      const size = await loadListSize();

      const warmup = Math.min(size, 12);
      for (let i = 0; i < warmup; i++) {
        await fetchElement(i);
      }
    } catch (e: any) {
      console.log("initCacheMode error:", e?.message ?? e);
      Alert.alert("Load Error", "Could not load cached list. Using local list instead.");
      setUseCacheMode(false);
    } finally {
      setLoading(false);
    }
  }, [fetchElement, loadListSize]);

  // intialize normal mode by loading entire list from server
  const initLocalMode = useCallback(async () => {
    try {
      setLoading(true);

      const { res, text } = await fetchText(LOAD_URL);
      console.log("LOAD raw:", text);

      // if no saved file yet
      if (text.includes("Unable to open file")) {
        setLoading(false);
        return;
      }

      if (!res.ok) throw new Error(`Load HTTP ${res.status}`);

      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Not JSON: ${text.slice(0, 30)}`);
      }

      setLocalItems(normalizeRemoteData(json));
    } catch (e: any) {
      console.log("initLocalMode error:", e?.message ?? e);
      Alert.alert("Load Error", "Could not load remote list. Using defaults.");
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount, initialize based on current mode (cache or local)
  useEffect(() => {
    if (useCacheMode) initCacheMode();
    else initLocalMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCacheMode]);

  // Basic load/save handlers
  const onLoad = useCallback(async () => {
    try {
      setBusy(true);
      if (useCacheMode) {
        await initCacheMode();
      } else {
        await initLocalMode();
      }
      Alert.alert("Loaded", "Load complete.");
    } catch (e) {
      Alert.alert("Load Error", "Could not load.");
    } finally {
      setBusy(false);
    }
  }, [initCacheMode, initLocalMode, useCacheMode]);

  // Ensure ALL items are available for saving (cache mode)
  const ensureAllCached = useCallback(async () => {
    const size = listSize;
    for (let i = 0; i < size; i++) {
      if (!cache.has(i)) {
        // eslint-disable-next-line no-await-in-loop
        await fetchElement(i);
      }
    }
  }, [cache, fetchElement, listSize]);

  const onSave = useCallback(async () => {
    try {
      setBusy(true);

      let itemsToSave: string[] = [];

      if (useCacheMode) {
        // fetch everything so save is complete
        await ensureAllCached();

        itemsToSave = Array.from({ length: listSize }, (_, i) => cache.get(i) ?? "").filter(
          (x) => x.trim().length > 0
        );
      } else {
        itemsToSave = localItems.map((i) => i.text);
      }

      const payload = { items: itemsToSave };

      const { res, text } = await fetchText(SAVE_URL);
     
      const saveRes = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const saveText = await saveRes.text();
      console.log("SAVE raw:", saveText);

      if (!saveRes.ok) {
        Alert.alert("Save Error", `Server error (${saveRes.status})`);
        return;
      }

      Alert.alert("Saved", "Save complete.");
    } catch (e: any) {
      console.log("Save error:", e?.message ?? e);
      Alert.alert("Save Error", "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [cache, ensureAllCached, listSize, localItems, useCacheMode]);

  // Add item handler: adds to end of list, either by putting in cache (cache mode) or local state (normal mode)
  const addItem = useCallback(() => {
    const trimmed = newText.trim();
    if (!trimmed) return;

    if (useCacheMode) {
      setListSize((prev) => {
        const nextIndex = prev;
        setCache((old) => {
          const next = new Map(old);
          next.set(nextIndex, trimmed);
          return next;
        });
        return prev + 1;
      });
    } else {
      setLocalItems((prev) => [...prev, { id: `${Date.now()}`, text: trimmed }]);
    }

    setNewText("");
    Keyboard.dismiss();
  }, [newText, useCacheMode]);

  const deleteAtIndex = useCallback((index: number) => {
    setCache((prev) => {
      const next = new Map(prev);
      for (let i = index; i < listSize - 1; i++) {
        const v = next.get(i + 1);
        if (v === undefined) next.delete(i);
        else next.set(i, v);
      }
      next.delete(listSize - 1);
      return next;
    });
    setListSize((prev) => Math.max(0, prev - 1));
  }, [listSize]);

  const deleteLocal = useCallback((id: string) => {
    setLocalItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // render loading state if we’re still initializing
  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10 }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  // Main UI
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 50 : 0}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={styles.container}>
          <Text style={styles.title}>Connected List App</Text>
          <Text style={styles.subtitle}>User: {USERNAME}</Text>

          {/* Mode toggle */}
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
            <Pressable
              onPress={() => setUseCacheMode(false)}
              style={[styles.modeBtn, !useCacheMode && styles.modeBtnActive]}
            >
              <Text style={!useCacheMode ? styles.modeTextActive : styles.modeText}>
                Normal Mode
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setUseCacheMode(true)}
              style={[styles.modeBtn, useCacheMode && styles.modeBtnActive]}
            >
              <Text style={useCacheMode ? styles.modeTextActive : styles.modeText}>
                Cache Mode (Extra Credit)
              </Text>
            </Pressable>
          </View>

          {/* Load / Save */}
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
            <Pressable onPress={onLoad} disabled={busy} style={[styles.actionBtn, busy && styles.disabled]}>
              <Text style={styles.actionText}>{busy ? "…" : "Load"}</Text>
            </Pressable>
            <Pressable onPress={onSave} disabled={busy} style={[styles.actionBtn, busy && styles.disabled]}>
              <Text style={styles.actionText}>{busy ? "…" : "Save"}</Text>
            </Pressable>
          </View>

          {/* Add row */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="New item…"
              value={newText}
              onChangeText={setNewText}
              onSubmitEditing={addItem}
              returnKeyType="done"
            />
            <Pressable onPress={addItem} hitSlop={10}>
              <Ionicons name="add-circle" size={34} color="green" />
            </Pressable>
          </View>

          {/* List */}
          {useCacheMode ? (
            <VirtualizedList
              data={indices}
              style={{ flex: 1 }}
              initialNumToRender={12}
              getItemCount={(data) => data.length}
              getItem={(data, index) => data[index]}
              keyExtractor={(item) => String(item)}
              renderItem={({ item: index }) => {
                const text = cache.get(index);

                // Trigger fetch when row is about to render
                if (text === undefined) {
                  fetchElement(index);
                  return (
                    <View style={styles.row}>
                      <Text style={styles.itemText}>Loading item {index}…</Text>
                      <ActivityIndicator />
                    </View>
                  );
                }

                return (
                  <View style={styles.row}>
                    <Text style={styles.itemText}>{text}</Text>
                    <Pressable onPress={() => deleteAtIndex(index)} hitSlop={10}>
                      <Ionicons name="trash" size={20} color="red" />
                    </Pressable>
                  </View>
                );
              }}
            />
          ) : (
            <VirtualizedList
              data={localItems}
              style={{ flex: 1 }}
              initialNumToRender={12}
              getItemCount={(data) => data.length}
              getItem={(data, index) => data[index]}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <View style={styles.row}>
                  <Text style={styles.itemText}>{item.text}</Text>
                  <Pressable onPress={() => deleteLocal(item.id)} hitSlop={10}>
                    <Ionicons name="trash" size={20} color="red" />
                  </Pressable>
                </View>
              )}
            />
          )}

          <StatusBar style="auto" />
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

// Styles
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, paddingTop: 55, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  title: { fontSize: 24, fontWeight: "700", marginBottom: 4 },
  subtitle: { color: "#555", marginBottom: 12 },

  modeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ccc",
    alignItems: "center",
  },
  modeBtnActive: { backgroundColor: "#111", borderColor: "#111" },
  modeText: { color: "#111" },
  modeTextActive: { color: "#fff", fontWeight: "600" },

  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#222",
    alignItems: "center",
  },
  actionText: { color: "#fff", fontWeight: "600" },
  disabled: { opacity: 0.5 },

  inputRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: "#ccc", padding: 10, borderRadius: 10 },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "#eee",
  },
  itemText: { fontSize: 16, flex: 1, marginRight: 10 },
});
