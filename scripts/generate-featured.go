package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	gameID            = 8694
	featuredPerPeriod = 5
	topSubsURL        = "https://gamebanana.com/apiv12/Game/8694/TopSubs"
	profileURL        = "https://gamebanana.com/apiv11/Mod"
	modIndexURL       = "https://gamebanana.com/apiv11/Mod/Index"
)

var categoryRoots = []int{28367, 34764, 3827, 43798, 43850, 43788}
var vsliceCategoryRoots = []int{29202}
var fetchCategoryRoots = uniqueInts(append(append([]int{}, categoryRoots...), vsliceCategoryRoots...))
var excludedModIDs = map[int]bool{309789: true}

var engineByCategory = map[int]EngineInfo{
	29202: {ID: "vslice", Name: "Base Game", Icon: "vslice.png", CategoryName: "Base Game Mod Folders"},
	28367: {ID: "psych", Name: "Psych Engine", Icon: "psych.png", CategoryName: "Psych Engine Mod Folders"},
	34764: {ID: "codename", Name: "Codename Engine", Icon: "codename.png", CategoryName: "Codename Engine Mod Folders"},
	3827:  {ID: "executable", Name: "Executable", Icon: "exe.png", CategoryName: "Executable Mod Folders"},
	43798: {ID: "pslice", Name: "P-Slice", Icon: "pslice.png", CategoryName: "P-Slice Mod Folders"},
	43850: {ID: "fpsplus", Name: "FPS Plus", Icon: "fpsplus.png", CategoryName: "FPS Plus Mod Folders"},
	43788: {ID: "psychonline", Name: "Psych Online", Icon: "psychonline.png", CategoryName: "Psych Online Mod Folders"},
}

var periods = []Period{
	{API: "today", ID: "day", Label: "Best of Today", Seconds: 24 * 60 * 60},
	{API: "week", ID: "week", Label: "Best of This Week", Seconds: 7 * 24 * 60 * 60},
	{API: "month", ID: "month", Label: "Best of This Month", Seconds: 30 * 24 * 60 * 60},
	{API: "3month", ID: "three-months", Label: "Best of 3 Months", Seconds: 90 * 24 * 60 * 60},
	{API: "6month", ID: "six-months", Label: "Best of 6 Months", Seconds: 180 * 24 * 60 * 60},
	{API: "year", ID: "year", Label: "Best of This Year", Seconds: 365 * 24 * 60 * 60},
	{API: "alltime", ID: "all-time", Label: "Best of All Time"},
}

type Period struct {
	API, ID, Label string
	Seconds        int64
}

type EngineInfo struct {
	ID, Name, Icon, CategoryName string
}

type Image struct {
	BaseURL string `json:"_sBaseUrl"`
	File    string `json:"_sFile"`
}

type PreviewMedia struct {
	Images []Image `json:"_aImages"`
}

type Submitter struct {
	Name string `json:"_sName"`
}

type Category struct {
	ID int `json:"_idRow"`
}

type Mod struct {
	ID            int           `json:"_idRow"`
	Name          string        `json:"_sName"`
	ProfileURL    string        `json:"_sProfileUrl"`
	ImageURL      string        `json:"_sImageUrl"`
	Text          string        `json:"_sText"`
	Description   string        `json:"_sDescription"`
	Period        string        `json:"_sPeriod"`
	DateAdded     int64         `json:"_tsDateAdded"`
	DateUpdated   int64         `json:"_tsDateUpdated"`
	DateModified  int64         `json:"_tsDateModified"`
	LikeCount     int64         `json:"_nLikeCount"`
	DownloadCount int64         `json:"_nDownloadCount"`
	ViewCount     int64         `json:"_nViewCount"`
	Submitter     *Submitter    `json:"_aSubmitter"`
	PreviewMedia  *PreviewMedia `json:"_aPreviewMedia"`
	SuperCategory *Category     `json:"_aSuperCategory"`
}

type CategoryMod struct {
	Mod        Mod
	CategoryID int
}

type Sources struct {
	TopSubs       []Mod
	Profiles      map[int]*Mod
	RecentGroups  [][]CategoryMod
	AllTimeGroups [][]CategoryMod
	profileMu     sync.RWMutex
}

type FeaturedMod struct {
	ID          int    `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Author      string `json:"author"`
	Image       string `json:"image"`
	Likes       int64  `json:"likes"`
	Downloads   int64  `json:"downloads"`
	Views       int64  `json:"views"`
	PublishedAt int64  `json:"publishedAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	URL         string `json:"url"`
	Engine      struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Icon string `json:"icon"`
	} `json:"engine"`
	Category struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"category"`
}

type Ranking struct {
	ID    string        `json:"id"`
	Label string        `json:"label"`
	Mods  []FeaturedMod `json:"mods"`
}

type Feed struct {
	SchemaVersion int       `json:"schemaVersion"`
	GeneratedAt   string    `json:"generatedAt"`
	Revision      string    `json:"revision"`
	GameID        int       `json:"gameId"`
	CategoryRoots []int     `json:"categoryRoots"`
	Rankings      []Ranking `json:"rankings"`
}

type feedContent struct {
	GameID        int       `json:"gameId"`
	CategoryRoots []int     `json:"categoryRoots"`
	Rankings      []Ranking `json:"rankings"`
}

type previousFeed struct {
	GeneratedAt string `json:"generatedAt"`
	Revision    string `json:"revision"`
}

var htmlTag = regexp.MustCompile(`<[^>]*>?`)

type generator struct {
	client *http.Client
}

func (g *generator) getJSON(ctx context.Context, endpoint string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	res, err := g.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("GameBanana returned %s", res.Status)
	}
	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		return err
	}
	return nil
}

func (g *generator) fetchTopSubs(ctx context.Context) ([]Mod, error) {
	var raw json.RawMessage
	if err := g.getJSON(ctx, topSubsURL, &raw); err != nil {
		return nil, fmt.Errorf("fetch TopSubs: %w", err)
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed[0] != '[' {
		return nil, errors.New("GameBanana returned an invalid TopSubs response")
	}
	var mods []Mod
	if err := json.Unmarshal(raw, &mods); err != nil {
		return nil, errors.New("GameBanana returned an invalid TopSubs response")
	}
	return mods, nil
}

func (g *generator) fetchProfile(ctx context.Context, modID int) (*Mod, error) {
	var profile Mod
	if err := g.getJSON(ctx, fmt.Sprintf("%s/%d/ProfilePage", profileURL, modID), &profile); err != nil {
		return nil, fmt.Errorf("fetch profile for mod %d: %w", modID, err)
	}
	return &profile, nil
}

func (g *generator) fetchCategory(ctx context.Context, categoryID int, sortName string, pageLimit int) ([]CategoryMod, error) {
	mods := make([]CategoryMod, 0)
	for page := 1; page <= pageLimit; page++ {
		params := url.Values{}
		params.Set("_sSort", sortName)
		params.Set("_nPage", fmt.Sprint(page))
		params.Set("_nPerpage", "50")
		params.Set("_aFilters[Generic_Game]", fmt.Sprint(gameID))
		params.Set("_aFilters[Generic_Category]", fmt.Sprint(categoryID))

		var response struct {
			Records []Mod `json:"_aRecords"`
		}
		if err := g.getJSON(ctx, modIndexURL+"?"+params.Encode(), &response); err != nil {
			return nil, fmt.Errorf("fetch category %d: %w", categoryID, err)
		}
		for _, mod := range response.Records {
			mods = append(mods, CategoryMod{Mod: mod, CategoryID: categoryID})
		}
		if len(response.Records) < 50 {
			break
		}
	}
	return mods, nil
}

func (g *generator) fetchCategoryGroups(ctx context.Context, categoryIDs []int, sortName string, pageLimit int) ([][]CategoryMod, error) {
	groups := make([][]CategoryMod, len(categoryIDs))
	errs := make(chan error, len(categoryIDs))
	var wg sync.WaitGroup
	for i, categoryID := range categoryIDs {
		wg.Add(1)
		go func(i, categoryID int) {
			defer wg.Done()
			var err error
			groups[i], err = g.fetchCategory(ctx, categoryID, sortName, pageLimit)
			if err != nil {
				errs <- err
			}
		}(i, categoryID)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		return nil, err
	}
	return groups, nil
}

func (g *generator) fetchSources(ctx context.Context) (*Sources, error) {
	var topSubs []Mod
	var recentGroups, allTimeGroups [][]CategoryMod
	errs := make(chan error, 3)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		var err error
		topSubs, err = g.fetchTopSubs(ctx)
		if err != nil {
			errs <- err
		}
	}()
	go func() {
		defer wg.Done()
		var err error
		recentGroups, err = g.fetchCategoryGroups(ctx, fetchCategoryRoots, "Generic_NewAndUpdated", 4)
		if err != nil {
			errs <- err
		}
	}()
	go func() {
		defer wg.Done()
		var err error
		allTimeGroups, err = g.fetchCategoryGroups(ctx, fetchCategoryRoots, "Generic_MostLiked", 1)
		if err != nil {
			errs <- err
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		return nil, err
	}

	profiles := make(map[int]*Mod)
	var profileMu sync.Mutex
	errs = make(chan error, len(uniqueMods(topSubs)))
	var profileWG sync.WaitGroup
	for _, mod := range uniqueMods(topSubs) {
		if excludedModIDs[mod.ID] {
			continue
		}
		mod := mod
		profileWG.Add(1)
		go func() {
			defer profileWG.Done()
			profile, err := g.fetchProfile(ctx, mod.ID)
			if err != nil {
				errs <- err
				return
			}
			profileMu.Lock()
			profiles[mod.ID] = profile
			profileMu.Unlock()
		}()
	}
	profileWG.Wait()
	close(errs)
	for err := range errs {
		return nil, err
	}
	return &Sources{TopSubs: topSubs, Profiles: profiles, RecentGroups: recentGroups, AllTimeGroups: allTimeGroups}, nil
}

func (s *Sources) profile(id int) *Mod {
	s.profileMu.RLock()
	defer s.profileMu.RUnlock()
	return s.Profiles[id]
}

func (s *Sources) setProfile(id int, profile *Mod) {
	s.profileMu.Lock()
	s.Profiles[id] = profile
	s.profileMu.Unlock()
}

func uniqueInts(values []int) []int {
	seen := make(map[int]bool, len(values))
	result := make([]int, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func uniqueMods(mods []Mod) []Mod {
	indexes := make(map[int]int, len(mods))
	result := make([]Mod, 0, len(mods))
	for _, mod := range mods {
		if index, ok := indexes[mod.ID]; ok {
			result[index] = mod
		} else {
			indexes[mod.ID] = len(result)
			result = append(result, mod)
		}
	}
	return result
}

func uniqueCategoryMods(mods []CategoryMod) []CategoryMod {
	indexes := make(map[int]int, len(mods))
	result := make([]CategoryMod, 0, len(mods))
	for _, entry := range mods {
		if excludedModIDs[entry.Mod.ID] {
			continue
		}
		if index, ok := indexes[entry.Mod.ID]; ok {
			result[index] = entry
		} else {
			indexes[entry.Mod.ID] = len(result)
			result = append(result, entry)
		}
	}
	return result
}

func score(mod Mod) int64 {
	return mod.LikeCount*1_000_000 + mod.DownloadCount*1_000 + mod.ViewCount
}

func activeSince(mod Mod, cutoff int64) bool {
	updated := mod.DateUpdated
	if updated == 0 {
		updated = mod.DateModified
	}
	return mod.DateAdded >= cutoff || updated >= cutoff
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func imageURL(mod Mod) string {
	if mod.ImageURL != "" {
		return mod.ImageURL
	}
	if mod.PreviewMedia != nil && len(mod.PreviewMedia.Images) > 0 {
		image := mod.PreviewMedia.Images[0]
		return image.BaseURL + "/" + image.File
	}
	return "https://images.gamebanana.com/img/ss/mods/default.jpg"
}

func cleanDescription(mod Mod, profile *Mod) string {
	profileText, profileDescription := "", ""
	if profile != nil {
		profileText, profileDescription = profile.Text, profile.Description
	}
	text := firstNonEmpty(profileText, mod.Text, mod.Description, profileDescription)
	return strings.Join(strings.Fields(htmlTag.ReplaceAllString(text, "")), " ")
}

func toFeaturedMod(entry CategoryMod, profile *Mod) FeaturedMod {
	mod := entry.Mod
	engine := engineByCategory[entry.CategoryID]
	result := FeaturedMod{
		ID:          mod.ID,
		Title:       mod.Name,
		Description: cleanDescription(mod, profile),
		Author:      "Unknown",
		Image:       imageURL(mod),
		Likes:       firstNonZero(mod.LikeCount, profileValue(profile, func(p *Mod) int64 { return p.LikeCount })),
		Downloads:   profileValue(profile, func(p *Mod) int64 { return p.DownloadCount }),
		Views:       profileValue(profile, func(p *Mod) int64 { return p.ViewCount }),
		PublishedAt: profileValue(profile, func(p *Mod) int64 { return p.DateAdded }),
		UpdatedAt:   firstNonZero(profileValue(profile, func(p *Mod) int64 { return p.DateUpdated }), profileValue(profile, func(p *Mod) int64 { return p.DateModified })),
		URL:         firstNonEmpty(mod.ProfileURL, profileValueString(profile, func(p *Mod) string { return p.ProfileURL }), fmt.Sprintf("https://gamebanana.com/mods/%d", mod.ID)),
	}
	if mod.Submitter != nil && mod.Submitter.Name != "" {
		result.Author = mod.Submitter.Name
	}
	result.Engine.ID, result.Engine.Name, result.Engine.Icon = engine.ID, engine.Name, engine.Icon
	result.Category.ID, result.Category.Name = entry.CategoryID, engine.CategoryName
	return result
}

func profileValue(profile *Mod, value func(*Mod) int64) int64 {
	if profile == nil {
		return 0
	}
	return value(profile)
}

func profileValueString(profile *Mod, value func(*Mod) string) string {
	if profile == nil {
		return ""
	}
	return value(profile)
}

func loadFallbackProfiles(ctx context.Context, g *generator, sources *Sources, entries []CategoryMod) []CategoryModProfile {
	result := make([]CategoryModProfile, len(entries))
	var wg sync.WaitGroup
	for i, entry := range entries {
		i, entry := i, entry
		wg.Add(1)
		go func() {
			defer wg.Done()
			profile := sources.profile(entry.Mod.ID)
			if profile == nil {
				var err error
				profile, err = g.fetchProfile(ctx, entry.Mod.ID)
				if err != nil {
					profile = &entry.Mod
				} else {
					sources.setProfile(entry.Mod.ID, profile)
				}
			}
			result[i] = CategoryModProfile{Entry: entry, Profile: profile}
		}()
	}
	wg.Wait()
	return result
}

type CategoryModProfile struct {
	Entry   CategoryMod
	Profile *Mod
}

func buildFeaturedData(ctx context.Context, g *generator, categoryRoots []int, sources *Sources) (Feed, error) {
	allowed := make(map[int]bool, len(categoryRoots))
	for _, categoryID := range categoryRoots {
		allowed[categoryID] = true
	}

	eligible := make([]CategoryMod, 0)
	for _, mod := range uniqueMods(sources.TopSubs) {
		if excludedModIDs[mod.ID] {
			continue
		}
		profile := sources.profile(mod.ID)
		if profile != nil && profile.SuperCategory != nil && allowed[profile.SuperCategory.ID] {
			eligible = append(eligible, CategoryMod{Mod: mod, CategoryID: profile.SuperCategory.ID})
		}
	}
	var recent, allTime []CategoryMod
	for _, group := range sources.RecentGroups {
		for _, entry := range group {
			if allowed[entry.CategoryID] {
				recent = append(recent, entry)
			}
		}
	}
	for _, group := range sources.AllTimeGroups {
		for _, entry := range group {
			if allowed[entry.CategoryID] {
				allTime = append(allTime, entry)
			}
		}
	}
	recent, allTime = uniqueCategoryMods(recent), uniqueCategoryMods(allTime)

	now := time.Now().Unix()
	featuredIDs := make(map[int]bool)
	rankings := make([]Ranking, 0, len(periods))
	for _, period := range periods {
		primary := make([]CategoryMod, 0)
		for _, entry := range eligible {
			if entry.Mod.Period == period.API && !featuredIDs[entry.Mod.ID] {
				primary = append(primary, entry)
			}
		}
		selected := make(map[int]bool, len(featuredIDs)+len(primary))
		for id := range featuredIDs {
			selected[id] = true
		}
		for _, entry := range primary {
			selected[entry.Mod.ID] = true
		}

		candidates := recent
		if period.Seconds == 0 {
			candidates = allTime
		}
		cutoff := now - period.Seconds
		fallback := make([]CategoryMod, 0)
		for _, entry := range candidates {
			if !selected[entry.Mod.ID] && (period.Seconds == 0 || activeSince(entry.Mod, cutoff)) {
				fallback = append(fallback, entry)
			}
		}
		sort.SliceStable(fallback, func(i, j int) bool {
			left, right := fallback[i].Mod, fallback[j].Mod
			if score(left) != score(right) {
				return score(left) > score(right)
			}
			return left.ID > right.ID
		})
		needed := featuredPerPeriod - len(primary)
		if needed < 0 {
			needed = 0
		}
		if len(fallback) > needed {
			fallback = fallback[:needed]
		}
		fallbackProfiles := loadFallbackProfiles(ctx, g, sources, fallback)

		mods := make([]FeaturedMod, 0, len(primary)+len(fallbackProfiles))
		for _, entry := range primary {
			mods = append(mods, toFeaturedMod(entry, sources.profile(entry.Mod.ID)))
			featuredIDs[entry.Mod.ID] = true
		}
		for _, entry := range fallbackProfiles {
			mods = append(mods, toFeaturedMod(entry.Entry, entry.Profile))
			featuredIDs[entry.Entry.Mod.ID] = true
		}
		rankings = append(rankings, Ranking{ID: period.ID, Label: period.Label, Mods: mods})
	}

	content := feedContent{GameID: gameID, CategoryRoots: categoryRoots, Rankings: rankings}
	encoded, err := json.Marshal(content)
	if err != nil {
		return Feed{}, err
	}
	hash := sha256.Sum256(encoded)
	feed := Feed{
		SchemaVersion: 3,
		GeneratedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Revision:      fmt.Sprintf("%x", hash[:])[:16],
		GameID:        content.GameID,
		CategoryRoots: content.CategoryRoots,
		Rankings:      content.Rankings,
	}
	if err := validateFeed(feed, allowed); err != nil {
		return Feed{}, err
	}
	return feed, nil
}

func validateFeed(feed Feed, allowed map[int]bool) error {
	for _, ranking := range feed.Rankings {
		if len(ranking.Mods) > featuredPerPeriod {
			return fmt.Errorf("ranking %s has too many mods", ranking.ID)
		}
		for _, mod := range ranking.Mods {
			if !allowed[mod.Category.ID] {
				return fmt.Errorf("mod %d has category %d outside feed", mod.ID, mod.Category.ID)
			}
		}
	}
	return nil
}

func readPrevious(path string) previousFeed {
	data, err := os.ReadFile(path)
	if err != nil {
		return previousFeed{}
	}
	var previous previousFeed
	if json.Unmarshal(data, &previous) != nil {
		return previousFeed{}
	}
	return previous
}

func writeFeed(path string, feed Feed) error {
	data, err := json.MarshalIndent(feed, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0644)
}

func main() {
	ctx := context.Background()
	g := &generator{client: &http.Client{Timeout: 60 * time.Second}}
	sources, err := g.fetchSources(ctx)
	if err != nil {
		panic(err)
	}

	featured, err := buildFeaturedData(ctx, g, categoryRoots, sources)
	if err != nil {
		panic(err)
	}
	if previous := readPrevious("public/featured.json"); previous.Revision == featured.Revision {
		featured.GeneratedAt = previous.GeneratedAt
	}

	vslice, err := buildFeaturedData(ctx, g, vsliceCategoryRoots, sources)
	if err != nil {
		panic(err)
	}
	if previous := readPrevious("public/featured-vslice.json"); previous.Revision == vslice.Revision {
		vslice.GeneratedAt = previous.GeneratedAt
	}

	if err := os.MkdirAll("public", 0755); err != nil {
		panic(err)
	}
	if err := writeFeed("public/featured.json", featured); err != nil {
		panic(err)
	}
	if err := writeFeed("public/featured-vslice.json", vslice); err != nil {
		panic(err)
	}
	if err := os.Remove("public/featured-manifest.json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		panic(err)
	}
}
