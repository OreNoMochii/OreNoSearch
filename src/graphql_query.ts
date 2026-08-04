export const CandidatesAttachmentQuery = `query CandidatesAttachment($searchId: ID!, $candidateIds: [String!]!) {
  search(id: $searchId) {
    id
    isOwner
    createdByPerson {
      id
      firstName
      __typename
    }
    candidates(candidateIds: $candidateIds) {
      id
      ...SearchCandidateFragment
      __typename
    }
    __typename
  }
  me {
    id
    workspace {
      id
      atsType
      candidatePostingDisabledReason
      ...CandidateCard_workspace
      __typename
    }
    __typename
  }
}

fragment SearchCandidateFragment on SearchCandidate {
  id
  searchId
  candidate {
    id
    firstName
    lastName
    linkedinUrl
    githubUrl
    atsUrl
    metaviewUrl
    experience {
      ...CandidateExperienceFragment
      __typename
    }
    education {
      id
      schoolName
      fieldOfStudy
      degree
      startDate {
        ...PartialDateFragment
        __typename
      }
      endDate {
        ...PartialDateFragment
        __typename
      }
      __typename
    }
    currentCompany {
      id
      name
      __typename
    }
    summary {
      ...CandidateSummaryFragment
      __typename
    }
    links {
      title
      url
      __typename
    }
    resume {
      id
      fileName
      createdAt
      __typename
    }
    resumeUrl
    latestRole {
      id
      jobTitle
      company {
        id
        name
        __typename
      }
      __typename
    }
    location {
      id
      name
      __typename
    }
    __typename
  }
  pipeline {
    id
    createdAt
    project {
      id
      name
      phase
      __typename
    }
    person {
      id
      name
      __typename
    }
    __typename
  }
  __typename
}

fragment CandidateExperienceFragment on Experience {
  id
  jobTitle
  description
  location
  company {
    id
    name
    sizeRange
    industry
    foundedYear
    website
    linkedinUrl
    hqLocation
    companyLogo
    coresignalId
    __typename
  }
  startDate {
    ...PartialDateFragment
    __typename
  }
  endDate {
    ...PartialDateFragment
    __typename
  }
  __typename
}

fragment PartialDateFragment on PartialDate {
  month
  year
  __typename
}

fragment CandidateSummaryFragment on CandidateSummary {
  title
  content
  __typename
}

fragment CandidateCard_workspace on Workspace {
  id
  atsType
  __typename
}`;
