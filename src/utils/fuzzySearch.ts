import FuzzySearch from 'fuzzy-search';
import { ISpace } from './types';

export class FuzzySpaceSearch {
  private fuzzySearch: FuzzySearch<ISpace>;

  constructor(spaces: ISpace[]) {
    this.fuzzySearch = new FuzzySearch(spaces, ['name', 'email', 'userName'], {
      caseSensitive: false,
      sort: true
    });
  }

  search(query: string): ISpace[] {
    if (!query.trim()) {
      return [];
    }
    return this.fuzzySearch.search(query);
  }

  static highlightMatch(text: string, query: string): string {
    if (!query.trim()) {
      return text;
    }

    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '\u001b[33m$1\u001b[0m'); // Yellow highlighting
  }

  static getSearchChoices(spaces: ISpace[], query: string = '', activeSpace?: string): Array<{ name: string; value: string; description?: string }> {
    const searcher = new FuzzySpaceSearch(spaces);
    const searchResults = query ? searcher.search(query) : spaces;

    return searchResults.map(space => ({
      name: space.name === activeSpace ? `🔥 ${space.name}` : space.name,
      value: space.name,
      description: `${space.email} (${space.userName})`
    }));
  }
}

export interface AutocompleteChoice {
  name: string;
  value: string;
  description?: string;
}

export class AutocompleteHelper {
  static async searchSpaces(
    spaces: ISpace[], 
    message: string,
    activeSpace?: string
  ): Promise<string> {
    const { input } = await import('@inquirer/prompts');
    
    let filteredSpaces = spaces;
    let query = '';

    while (true) {
      const choices = FuzzySpaceSearch.getSearchChoices(filteredSpaces, query, activeSpace);
      
      if (choices.length === 0 && query) {
        console.log('\n❌ No spaces match your search. Try a different query.');
        query = '';
        filteredSpaces = spaces;
        continue;
      }

      const prompt = query 
        ? `${message} (filtered by: "${query}")`
        : `${message} (type to search)`;

      try {
        const answer = await input({
          message: prompt,
          validate: (input) => {
            if (!input.trim()) {
              return 'Please enter a space name or search term';
            }
            return true;
          }
        });

        // If input matches exactly, return it
        const exactMatch = spaces.find(s => s.name.toLowerCase() === answer.toLowerCase());
        if (exactMatch) {
          return exactMatch.name;
        }

        // Otherwise, use as search query
        query = answer;
        const searcher = new FuzzySpaceSearch(spaces);
        filteredSpaces = searcher.search(query);

        // If only one result, return it
        if (filteredSpaces.length === 1) {
          return filteredSpaces[0].name;
        }

        // If multiple results, show them
        if (filteredSpaces.length > 1) {
          console.log(`\n🔍 Found ${filteredSpaces.length} matches:`);
          filteredSpaces.forEach((space, index) => {
            const isActive = space.name === activeSpace;
            const displayName = isActive ? `🔥 ${space.name}` : space.name;
            console.log(`  ${index + 1}. ${displayName} (${space.email})`);
          });
          console.log('');
        }
      } catch (error) {
        throw error;
      }
    }
  }
}