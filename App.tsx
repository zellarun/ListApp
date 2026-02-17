import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  SafeAreaView,
  VirtualizedList,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
  SafeAreaViewBase,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const USERNAME = "zellarunningr";

// Load and Save URLs
const LOAD_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/loadjson.php?user=${USERNAME}`;
const SAVE_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/savejson.php?user=${USERNAME}`;

// Cache URLs
const LISTSIZE_URL = `https://mec402.boisestate.edu/csclasses/cs402/codesnips/listsize.php?user=${USERNAME}`;
const GETELEMENT_URL = (itemNumber: number) =>
  `https://mec402.boisestate.edu/csclasses/cs402/codesnips/getelement.php?user=${USERNAME}&item=${itemNumber}`;

// Types and Initial Data
type ListItem = {
  id: string;
  text: string;
  parts?: string[]; // used for join/split
  _cached?: boolean; // false = placeholder not yet fetched from server
};

// Tab keys
type TabKey = 'Todo' | 'School' | 'Errands';

// Available tabs
const tabs: TabKey[] = ['Todo', 'School', 'Errands'];

// Initial lists for each tab
const initialLists: Record<TabKey, ListItem[]> = {
  Todo: [
    { id: 'todo-1', text: 'Buy groceries' },
    { id: 'todo-2', text: 'Walk the dog' },
    { id: 'todo-3', text: 'Read a book' },
  ],
  School: [
    { id: 'school-1', text: 'Finish readings' },
    { id: 'school-2', text: 'Submit HW' },
  ],
  Errands: [
    { id: 'errands-1', text: 'Post office' },
    { id: 'errands-2', text: 'Get gas' },
  ],
};

// Helper to normalize remote data into ListItem[]
function normalizeRemoteData(raw: any): ListItem[] {
  let arr = raw;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.items)) arr = raw.items;
    else if (Array.isArray(raw.data)) arr = raw.data;
    else arr = [];
  }

  if (!Array.isArray(arr)) return [];

  return arr
    .map((x, idx) => {
      // string case
      if(typeof x === "string"){ 
        return { id: `${Date.now()}-${idx}`, text: x };
      }

      // object case
      if (typeof x === "object" && x !== null) {
        const text = x.text ?? x.name ?? x.value ?? JSON.stringify(x);
        const id = x.id ?? `${Date.now()} ~ ${idx}`;
        return { id: String(id), text: String(text) };
      }

    return { id: `${Date.now()}-${idx}`, text: String(x) };
  })
  .filter((item) => item.text.trim().length > 0);
}

// Cache class to store fetched items in memory and track in-flight requests
class ItemCache {
  private cache: Map<number, string> = new Map();
  private inflight: Set<number> = new Set();

  has(index: number): boolean { return this.cache.has(index); }
  get(index: number): string | undefined { return this.cache.get(index); }
  isInflight(index: number): boolean { return this.inflight.has(index); }
  startFetch(index: number) { this.inflight.add(index); }
  set(index: number, value: string) { this.cache.set(index, value); this.inflight.delete(index); }
  failFetch(index: number) { this.inflight.delete(index); }
  clear() { this.cache.clear(); this.inflight.clear(); }
  size(): number { return this.cache.size; }
}

// Main App Component
export default function App() {

  const [activeTab, setActiveTab] = useState<TabKey>('Todo');
  const [lists, setLists] = useState<Record<TabKey, ListItem[]>>(initialLists);

  const [newText, setNewText] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [didInitialLoad, setDidInitialLoad] = useState(false);
  const listRef = useRef<VirtualizedList<ListItem>>(null);

  // Loading and busy states
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Cache state: placeholder array sized to the remote list, the cache itself, and fetch stats
  const [remoteItems, setRemoteItems] = useState<ListItem[]>([]);
  const [showCache, setShowCache] = useState(false);
  const [cacheStats, setCacheStats] = useState({ fetched: 0, total: 0 });
  const cacheRef = useRef<ItemCache>(new ItemCache());

  const items = showCache ? remoteItems : lists[activeTab];

  // Helper to update items for the active tab
  const setItemsForTab = (updater: (prev: ListItem[]) => ListItem[]) => {
    setLists((prev) => ({
      ...prev,
      [activeTab]: updater(prev[activeTab]),
    }));
  };

  // Fetch total list size from server, then build a placeholder model large
  // enough to hold the entire table with links to the cache
  const fetchRemoteListSize = useCallback(async () => {
    try {
      const response = await fetch(LISTSIZE_URL);
      const text = await response.text();
      console.log("LISTSIZE RESPONSE:", text);

      const size = parseInt(text.trim(), 10);
      if (!isNaN(size) && size > 0) {
        // Build placeholder array — each entry will be filled when rendered
        const placeholders: ListItem[] = Array.from({ length: size }, (_, i) => ({
          id: `remote-${i}`,
          text: '…',
          _cached: false,
        }));
        setRemoteItems(placeholders);
        setCacheStats({ fetched: 0, total: size });
      }
    } catch (err: any) {
      console.log("listsize fetch error:", err?.message ?? err);
    }
  }, []);

  // Fetch a single item by index and store it in the cache
  const fetchAndCacheItem = useCallback(async (index: number) => {
    const cache = cacheRef.current;
    if (cache.has(index) || cache.isInflight(index)) return;

    cache.startFetch(index);
    try {
      const response = await fetch(GETELEMENT_URL(index));
      const text = await response.text();
      console.log(`GETELEMENT[${index}]:`, text);

      // Parse response — server may return JSON or plain text
      let itemText = text.trim();
      try {
        const json = JSON.parse(itemText);
        if (typeof json === 'string') itemText = json;
        else if (typeof json === 'object' && json !== null)
          itemText = json.item ?? json.text ?? json.value ?? json.name ?? JSON.stringify(json);
      } catch { /* not JSON, use raw text */ }

      cache.set(index, itemText);

      // Update only the one placeholder slot so that row re-renders
      setRemoteItems((prev) => {
        const next = [...prev];
        next[index] = { id: `remote-${index}`, text: itemText, _cached: true };
        return next;
      });

      setCacheStats((s) => ({ ...s, fetched: cache.size() }));
    } catch (err: any) {
      cache.failFetch(index);
      console.log(`fetchAndCacheItem[${index}] error:`, err?.message ?? err);
    }
  }, []);

  // Load data on mount
  const loadInitialData = useCallback(async () => {
  try {
    setLoading(true);

    const response = await fetch(LOAD_URL);
    const text = await response.text();

    console.log("INITIAL LOAD RAW RESPONSE:", text);

    if (text.includes("Unable to open file")) {
      console.log("No saved file yet; using defaults.");
      // Keep initialLists already in state
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      Alert.alert("Load Error", "Server did not return JSON. Check console logs.");
      console.log("Not valid JSON:", text.slice(0, 200));
      return;
    }

    const normalized = normalizeRemoteData(json);

    setLists((prev) => ({
      ...prev,
      [activeTab]: normalized,
    }));
  } catch (error: any) {
    Alert.alert("Load Error", "Failed to connect to server.");
    console.log("Load error:", error?.message ?? error);
  } finally {
    setLoading(false);
    setDidInitialLoad(true);
  }
}, [activeTab]);

  useEffect(() => {
    loadInitialData();
    fetchRemoteListSize(); // also get remote list size for cache on mount
  }, [loadInitialData]);

  // Load and Save handlers
 const onLoad = useCallback(async () => {
  try {
    setBusy(true);

    const response = await fetch(LOAD_URL);
    const text = await response.text();

    console.log("LOAD BUTTON RAW RESPONSE:", text);

    if (text.includes("Unable to open file")) {
      Alert.alert("No Saved List Yet", "Nothing saved for this user yet. Add items and press Save first.");
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      Alert.alert("Load Error", "Server did not return JSON.");
      console.log("Not valid JSON:", text.slice(0, 200));
      return;
    }

    const normalized = normalizeRemoteData(json);

    // Load into CACHE list only
    cacheRef.current.clear();
    setRemoteItems(
      normalized.map((it, idx) => ({
        id: `remote-${idx}`,
        text: it.text,
        _cached: true,
      }))
    );
    setCacheStats({ fetched: normalized.length, total: normalized.length });
    setShowCache(true);

    Alert.alert("Success", "Remote list loaded into Cache tab!");
  } catch (error: any) {
    Alert.alert("Error", "Failed to load data.");
    console.log("Load error:", error?.message ?? error);
  } finally {
    setBusy(false);
  }
}, []);


  // Save handler
  const onSave = useCallback(async () => {
  try {
    setBusy(true);

    // Save CACHE list when in cache mode
    const payload = {
      items: (showCache ? remoteItems : lists[activeTab])
        .map((i) => i.text)
        .filter((t) => t.trim().length > 0),
    };

    const response = await fetch(SAVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log("SAVE RAW RESPONSE:", text);

    if (!response.ok) {
      Alert.alert("Save Error", "Server returned an error.");
      console.log("HTTP error:", response.status, text);
      return;
    }

    // Refresh listsize placeholders so Cache mode can lazy-load too
    cacheRef.current.clear();
    fetchRemoteListSize();

    Alert.alert("Success", showCache ? "Cache list saved!" : "Tab list saved!");
  } catch (error: any) {
    Alert.alert("Error", "Failed to save data.");
    console.log("Save error:", error?.message ?? error);
  } finally {
    setBusy(false);
  }
}, [showCache, remoteItems, lists, activeTab, fetchRemoteListSize]);



  // Handlers
  const switchTab = (tab: TabKey) => {
    setActiveTab(tab);
    setSelectedIds([]);
    setNewText(" ");
    setShowCache(false); // return to tab view when switching tabs
    
    // Scroll to top when switching tabs
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    });

    Keyboard.dismiss();
  };

  // Add new item
  const addItem = () => {
    const trimmed = newText.trim();
    if (trimmed === '') return;

    const newItem: ListItem = {
      id: `${activeTab}-${Date.now()}`,
      text: trimmed,
    };

    // Update state
    setItemsForTab((prev) => [...prev, newItem]);
    setNewText('');
    Keyboard.dismiss();
  };

  // Delete item
  const deleteItem = (id: string) => {
    setItemsForTab((prev) => prev.filter((i) => i.id !== id));
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  };

  // Toggle selection
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // Join selected items
  const joinSelected = () => {
    if (selectedIds.length < 2) return;

    const selected = items.filter((i) => selectedIds.includes(i.id));
    const remaining = items.filter((i) => !selectedIds.includes(i.id));

    const joined: ListItem = {
      id: Date.now().toString(),
      text: selected.map((i) => i.text).join(' / '),
      parts: selected.map((i) => i.text),
    };

    setItemsForTab(() => [...remaining, joined]);
    setSelectedIds([]);
  };

  // Split item
  const splitItem = (item: ListItem) => {
    if (!item.parts) return;

    const splitItems: ListItem[] = item.parts.map((text) => ({
      id: `${Date.now()}-${Math.random()}`,
      text,
    }));

    setItemsForTab((prev) => prev.filter((i) => i.id !== item.id).concat(splitItems));
  };

  // Show loading indicator
  if (loading && !didInitialLoad) {
  return (
    <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
      <Text style={{ marginTop: 10 }}>Loading Remote List...</Text>
    </SafeAreaView>
  );
}


  // Render
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 50 : 0}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={styles.container}>
          <Text style={styles.title}>Simple List App</Text>

          {/* Tabs */}
          <View style={styles.tabRow}>
            {tabs.map((tab) => (
              <Pressable
                key={tab}
                onPress={() => switchTab(tab)}
                style={[styles.tab, activeTab === tab && !showCache && styles.tabActive]}
              >
                <Text
                  style={[
                    styles.tabText,
                    activeTab === tab && !showCache && styles.tabTextActive,
                  ]}
                >
                  {tab}
                </Text>
              </Pressable>
            ))}

            {/* Cache view tab — shows remote list loaded lazily via getelement.php */}
            <Pressable
              onPress={() => { setShowCache((v) => !v); setSelectedIds([]); }}
              style={[styles.tab, showCache && styles.tabActive]}
            >
              <Text style={[styles.tabText, showCache && styles.tabTextActive]}>
                Cache
              </Text>
            </Pressable>
          </View>

          {/* Cache stats banner — visible only in cache mode */}
          {showCache && (
            <Text style={styles.cacheStats}>
              Remote: {cacheStats.total} items · Cached in memory: {cacheStats.fetched}
            </Text>
          )}

          {/* Load and Save button */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            <Pressable
              onPress={onLoad}
              disabled={busy}
              style={[styles.joinButton, busy && { opacity: 0.5 }]}
            >
              <Text style={styles.joinText}>Load</Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              disabled={busy}
              style={[styles.joinButton, busy && { opacity: 0.5 }]}
            >
              <Text style={styles.joinText}>Save</Text>
            </Pressable>
          </View> 

          {/* Join button */}
          <Pressable
            style={[
              styles.joinButton,
              selectedIds.length < 2 && styles.joinButtonDisabled,
            ]}
            onPress={joinSelected}
            disabled={selectedIds.length < 2}
          >
            <Text style={styles.joinText}>Join Selected ({selectedIds.length})</Text>
          </Pressable>

          {/* List */}
          <VirtualizedList
            key={showCache ? "cache" : activeTab}
            extraData={{ activeTab, showCache, selectedIds}}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            keyboardShouldPersistTaps="handled"
            data={items}
            initialNumToRender={12}
            getItemCount={(data) => data.length}
            getItem={(data, index) => data[index]}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => {
              const selected = selectedIds.includes(item.id);

              // When the VirtualizedList renders this row and it isn't cached yet,
              // fire a fetch for that single element and store it in the cache
              if (showCache && !item._cached) {
                fetchAndCacheItem(index);
              }

              return (
                <Pressable
                  onPress={() => toggleSelect(item.id)}
                  style={[styles.row, selected && styles.selectedRow]}
                >
                  {/* Show spinner inline while this item is being fetched into cache */}
                  {showCache && !item._cached ? (
                    <ActivityIndicator size="small" style={{ marginRight: 8 }} />
                  ) : null}
                  <Text style={styles.itemText}>{item.text}</Text>

                  <View style={styles.icons}>
                    {!!item.parts && (
                      <Pressable onPress={() => splitItem(item)} hitSlop={10}>
                        <Ionicons name="cut" size={20} />
                      </Pressable>
                    )}

                    <Pressable onPress={() => deleteItem(item.id)} hitSlop={10}>
                      <Ionicons name="trash" size={20} color="red" />
                    </Pressable>
                  </View>
                </Pressable>
              );
            }}
          />

          {/* Input row */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder={`New item for ${activeTab}`}
              value={newText}
              onChangeText={setNewText}
              onSubmitEditing={addItem}
              returnKeyType="done"
            />
            <Pressable onPress={addItem} hitSlop={10}>
              <Ionicons name="add-circle" size={34} color="green" />
            </Pressable>
          </View>

          <StatusBar style="auto" />
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

// Styles
const styles = StyleSheet.create({
  container: { flex: 1, padding: 30, paddingTop: 60, backgroundColor: '#fff' },
  title: { fontSize: 24, marginBottom: 12 },

  tabRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 12,
  },
  tabActive: { backgroundColor: '#111', borderColor: '#111' },
  tabText: { fontSize: 14, color: '#111' },
  tabTextActive: { color: '#fff' },

  cacheStats: { fontSize: 13, color: '#555', marginBottom: 8 },

  joinButton: {
    padding: 10,
    backgroundColor: '#ddd',
    marginBottom: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  joinButtonDisabled: { opacity: 0.5 },
  joinText: { fontSize: 16 },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 10,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  selectedRow: { backgroundColor: '#e0e0e0' },
  itemText: { fontSize: 16 },

  icons: { flexDirection: 'row', gap: 12 },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
    paddingBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    flex: 1,
    borderRadius: 8,
  },
});
